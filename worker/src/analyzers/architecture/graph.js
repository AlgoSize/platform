// Repository → service/dependency graph.
//
// Static analysis only: we read the files we were handed and nothing else.
// No network calls, no LLM, no reaching into the infrastructure being
// analyzed — same posture as the vuln analyzer's lockfile path.
//
// Everything emitted here carries `file:line` evidence. That is not
// decoration: a diagram that says "these two services talk" without being
// able to show where it read that is indistinguishable from a guess, and the
// scoring pass drops any finding whose evidence is missing.
//
// What this understands, and nothing more:
//   wrangler.toml          a Worker, its bindings, its crons
//   docker-compose.yml     services, images, published ports, depends_on
//   Dockerfile             base image pinning
//   Kubernetes manifests   Deployment / Service / Ingress
//   Terraform (*.tf)       a small set of AWS resource types
//   Jekyll _config.yml     a static site
//   source files           cross-cluster imports, fetch() to known hosts
//
// Anything else is reported as unanalyzed rather than silently ignored — see
// `coverage` on the returned graph. Claiming to have mapped an architecture
// while quietly skipping half its manifests is the failure mode this whole
// module exists to avoid.

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------

/** Strip a trailing `#` comment, ignoring `#` inside quotes. */
function stripComment(line) {
  let inSingle = false, inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "#" && !inSingle && !inDouble) return line.slice(0, i);
  }
  return line;
}

function unquote(v) {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

const basename = (p) => String(p).split("/").pop();
const evidence = (path, line) => `${path}:${line}`;

// ---------------------------------------------------------------------------
// Graph accumulator
// ---------------------------------------------------------------------------

function makeBuilder() {
  return {
    nodes:    new Map(),   // id → node
    edges:    [],
    clusters: new Map(),   // id → cluster
    coverage: { analyzed: [], skipped: [] },

    addCluster(id, { name, kind, file, line }) {
      if (!this.clusters.has(id)) {
        this.clusters.set(id, { id, name, kind, evidence: evidence(file, line), nodes: [] });
      }
      return this.clusters.get(id);
    },

    addNode(id, { kind, name, cluster = null, file, line }) {
      const existing = this.nodes.get(id);
      if (existing) {
        if (file && !existing.files.includes(file)) existing.files.push(file);
        // A resource declared by two clusters belongs to neither — it is
        // shared infrastructure, and saying so is the point (see the
        // "datastore reachable from more than its owning service" rule).
        if (cluster && existing.cluster && existing.cluster !== cluster) {
          existing.cluster = null;
          existing.shared = true;
        } else if (cluster && !existing.cluster && !existing.shared) {
          existing.cluster = cluster;
        }
        return existing;
      }
      const node = {
        id, kind, name, cluster,
        files: file ? [file] : [],
        evidence: file ? evidence(file, line) : null,
      };
      this.nodes.set(id, node);
      return node;
    },

    addEdge(from, to, kind, { file, line, via = null }) {
      if (!from || !to || from === to) return;
      this.edges.push({ from, to, kind, evidence: evidence(file, line), ...(via ? { via } : {}) });
    },
  };
}

// ---------------------------------------------------------------------------
// wrangler.toml — a Cloudflare Worker and everything bound to it
// ---------------------------------------------------------------------------

/**
 * Walk a TOML file emitting one record per table, with the line each key was
 * found on.
 *
 * A real TOML parser would be better, but the worker has no TOML dependency
 * and adding one to read config we only need five keys out of is not a good
 * trade. This handles the subset wrangler configs actually use: `[table]`,
 * `[[array.of.tables]]`, and `key = value`.
 */
function scanToml(content) {
  const tables = [];
  let current = { section: "", keys: new Map() };
  tables.push(current);

  content.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    const s = stripComment(raw).trim();
    if (!s) return;

    const arrayTable = s.match(/^\[\[([^\]]+)\]\]$/);
    if (arrayTable) {
      current = { section: arrayTable[1].trim(), keys: new Map(), line, isArrayItem: true };
      tables.push(current);
      return;
    }
    const table = s.match(/^\[([^\]]+)\]$/);
    if (table) {
      current = { section: table[1].trim(), keys: new Map(), line, isArrayItem: false };
      tables.push(current);
      return;
    }
    const kv = s.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (kv) current.keys.set(kv[1], { value: unquote(kv[2]), line });
  });

  return tables;
}

/** `[env.production.kv_namespaces]` → `kv_namespaces`; top-level stays as-is. */
function tomlSuffix(section) {
  return section.replace(/^env\.[A-Za-z0-9_-]+\./, "");
}

/**
 * Which environment a wrangler table belongs to.
 *
 * Environments are folded onto one cluster (the operator deploys one Worker),
 * but the resources they bind are genuinely different instances — production
 * and staging databases are not the same database. Tagging them keeps the
 * cost lens from reporting "you have two databases" about a perfectly normal
 * prod/staging split.
 */
function tomlEnv(section) {
  const m = section.match(/^env\.([A-Za-z0-9_-]+)/);
  return m ? m[1] : "default";
}

function parseWrangler(file, content, b) {
  const tables = scanToml(content);
  const root = tables[0];
  const nameEntry = root.keys.get("name");
  if (!nameEntry) return false;

  const workerName = nameEntry.value;
  const clusterId  = `worker:${workerName}`;
  b.addCluster(clusterId, { name: workerName, kind: "worker", file: file.path, line: nameEntry.line });
  b.addNode(clusterId, { kind: "worker", name: workerName, cluster: clusterId, file: file.path, line: nameEntry.line });

  for (const t of tables) {
    // Per-environment blocks bind the same resources; folding them onto the
    // base section keeps one node per real resource instead of one per
    // environment, which is what the operator actually runs.
    const section = tomlSuffix(t.section);
    const env = tomlEnv(t.section);
    const at = (key) => t.keys.get(key);
    const tag = (node) => { if (node && !node.env) node.env = env; return node; };

    if (section === "kv_namespaces") {
      const binding = at("binding");
      if (!binding) continue;
      const id = `kv:${(at("id") && at("id").value) || binding.value}`;
      tag(b.addNode(id, { kind: "kv", name: binding.value, cluster: clusterId, file: file.path, line: binding.line }));
      b.addEdge(clusterId, id, "binding", { file: file.path, line: binding.line, via: "kv_namespaces" });
    }

    if (section === "d1_databases") {
      const binding = at("binding");
      const dbName  = at("database_name");
      if (!binding) continue;
      const id = `d1:${(dbName && dbName.value) || binding.value}`;
      tag(b.addNode(id, {
        kind: "database", name: (dbName && dbName.value) || binding.value,
        cluster: clusterId, file: file.path, line: binding.line,
      }));
      b.addEdge(clusterId, id, "binding", { file: file.path, line: binding.line, via: "d1_databases" });
    }

    if (section === "r2_buckets") {
      const binding = at("binding");
      const bucket  = at("bucket_name");
      if (!binding) continue;
      const id = `r2:${(bucket && bucket.value) || binding.value}`;
      tag(b.addNode(id, {
        kind: "bucket", name: (bucket && bucket.value) || binding.value,
        cluster: clusterId, file: file.path, line: binding.line,
      }));
      b.addEdge(clusterId, id, "binding", { file: file.path, line: binding.line, via: "r2_buckets" });
    }

    if (section === "queues.producers") {
      const q = at("queue");
      if (!q) continue;
      const id = `queue:${q.value}`;
      tag(b.addNode(id, { kind: "queue", name: q.value, cluster: clusterId, file: file.path, line: q.line }));
      b.addEdge(clusterId, id, "queue", { file: file.path, line: q.line, via: "queues.producers" });
    }

    if (section === "queues.consumers") {
      const q = at("queue");
      if (!q) continue;
      const id = `queue:${q.value}`;
      tag(b.addNode(id, { kind: "queue", name: q.value, cluster: clusterId, file: file.path, line: q.line }));
      b.addEdge(id, clusterId, "queue", { file: file.path, line: q.line, via: "queues.consumers" });
    }

    if (section === "services") {
      const svc = at("service");
      if (!svc) continue;
      const id = `worker:${svc.value}`;
      b.addNode(id, { kind: "worker", name: svc.value, cluster: id, file: file.path, line: svc.line });
      b.addEdge(clusterId, id, "binding", { file: file.path, line: svc.line, via: "services" });
    }

    if (section === "durable_objects.bindings") {
      const cls = at("class_name") || at("name");
      if (!cls) continue;
      const id = `do:${cls.value}`;
      tag(b.addNode(id, { kind: "durable_object", name: cls.value, cluster: clusterId, file: file.path, line: cls.line }));
      b.addEdge(clusterId, id, "binding", { file: file.path, line: cls.line, via: "durable_objects" });
    }

    if (section === "triggers") {
      const crons = at("crons");
      if (!crons) continue;
      const id = `cron:${workerName}`;
      b.addNode(id, { kind: "cron", name: `${workerName} schedule`, cluster: clusterId, file: file.path, line: crons.line });
      b.addEdge(id, clusterId, "cron", { file: file.path, line: crons.line, via: "triggers.crons" });
    }

    // Routes make the Worker publicly reachable — needed by the security lens.
    if (section === "" || /^env\.[A-Za-z0-9_-]+$/.test(t.section)) {
      const routes = at("routes") || at("route");
      if (routes) {
        const node = b.nodes.get(clusterId);
        if (node) {
          node.publiclyReachable = true;
          node.publicEvidence = evidence(file.path, routes.line);
        }
      }
      const wd = at("workers_dev");
      if (wd && /true/i.test(String(wd.value))) {
        const node = b.nodes.get(clusterId);
        if (node) {
          node.publiclyReachable = true;
          node.publicEvidence = node.publicEvidence || evidence(file.path, wd.line);
        }
      }
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// docker-compose
// ---------------------------------------------------------------------------

const DB_IMAGE_RE = /^(postgres|mysql|mariadb|mongo|redis|memcached|elasticsearch|opensearch|cassandra|clickhouse|cockroachdb|neo4j)\b/i;
const GATEWAY_IMAGE_RE = /^(nginx|traefik|haproxy|envoyproxy\/envoy|caddy|kong)\b/i;
const STATIC_IMAGE_RE = /^(nginx|httpd|caddy)\b/i;

/**
 * Parse the subset of compose we need. Indentation-driven rather than a real
 * YAML parse, for the same reason as the TOML scanner: no dependency, and we
 * need line numbers for every fact we extract anyway.
 */
function parseCompose(file, content, b) {
  const lines = content.split(/\r?\n/);
  let inServices = false;
  let currentSvc = null;
  let currentKey = null;

  const services = new Map();

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = i + 1;
    const s = stripComment(raw);
    if (!s.trim()) continue;

    const indent = s.length - s.trimStart().length;
    const text = s.trim();

    if (indent === 0) {
      inServices = /^services:\s*$/.test(text);
      currentSvc = null;
      currentKey = null;
      continue;
    }
    if (!inServices) continue;

    // `  name:` — a service
    if (indent === 2 && /^[A-Za-z0-9_.-]+:\s*$/.test(text)) {
      const name = text.slice(0, -1);
      currentSvc = {
        name, line,
        image: null, imageLine: line,
        ports: [], dependsOn: [], envLines: [],
        replicas: null,
        logging: false, loggingOptions: false,
      };
      services.set(name, currentSvc);
      currentKey = null;
      continue;
    }
    if (!currentSvc) continue;

    if (indent === 4) {
      const kv = text.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
      if (!kv) continue;
      currentKey = kv[1];
      const value = kv[2].trim();

      if (currentKey === "image" && value) {
        currentSvc.image = unquote(value);
        currentSvc.imageLine = line;
      }
      if (currentKey === "logging") currentSvc.logging = true;
      if (currentKey === "ports" && value && value.startsWith("[")) {
        // inline list form: ports: ["5432:5432"]
        for (const p of value.replace(/^\[|\]$/g, "").split(",")) {
          const v = unquote(p.trim());
          if (v) currentSvc.ports.push({ value: v, line });
        }
      }
      continue;
    }

    // list items under the current key
    const item = text.match(/^-\s*(.+)$/);
    if (item && currentKey) {
      const value = unquote(item[1].trim());
      if (currentKey === "ports")      currentSvc.ports.push({ value, line });
      if (currentKey === "depends_on") currentSvc.dependsOn.push({ value, line });
      continue;
    }

    // nested scalars we care about (deploy.replicas, logging options)
    const nested = text.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (nested) {
      if (nested[1] === "replicas") currentSvc.replicas = { value: nested[2].trim(), line };
      if (/^max-size$/.test(nested[1])) currentSvc.loggingOptions = true;
      // `depends_on:` in mapping form lists services as nested keys
      if (currentKey === "depends_on" && nested[2] === "") {
        currentSvc.dependsOn.push({ value: nested[1], line });
      }
    }
  }

  if (services.size === 0) return false;

  for (const svc of services.values()) {
    const id = `svc:${svc.name}`;
    const isDb = svc.image && DB_IMAGE_RE.test(svc.image);
    const kind = isDb ? "database" : "service";

    b.addCluster(id, { name: svc.name, kind: "compose_service", file: file.path, line: svc.line });
    const node = b.addNode(id, { kind, name: svc.name, cluster: id, file: file.path, line: svc.line });

    node.image = svc.image || null;
    node.imageEvidence = evidence(file.path, svc.imageLine);
    if (svc.replicas) node.scaleEvidence = evidence(file.path, svc.replicas.line);
    if (svc.image && GATEWAY_IMAGE_RE.test(svc.image)) node.isGateway = true;
    if (svc.image && STATIC_IMAGE_RE.test(svc.image)) node.servesStatic = true;
    node.logging = { configured: svc.logging, bounded: svc.loggingOptions };

    // A published port is what makes something reachable from outside the
    // compose network. `HOST:CONTAINER` publishes; a bare `CONTAINER` also
    // publishes (on a random host port). `127.0.0.1:5432:5432` does not
    // expose it beyond the host, which is the distinction the security lens
    // turns on.
    for (const p of svc.ports) {
      const parts = String(p.value).split(":");
      const boundToLoopback = parts.length === 3 && /^(127\.0\.0\.1|localhost|::1)$/.test(parts[0]);
      if (!boundToLoopback) {
        node.publiclyReachable = true;
        node.publicEvidence = evidence(file.path, p.line);
        node.publishedPorts = node.publishedPorts || [];
        node.publishedPorts.push(p.value);
      }
    }
  }

  for (const svc of services.values()) {
    for (const dep of svc.dependsOn) {
      const target = `svc:${dep.value}`;
      if (!b.nodes.has(target)) continue;
      b.addEdge(`svc:${svc.name}`, target, "http", {
        file: file.path, line: dep.line, via: "depends_on",
      });
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Dockerfile
// ---------------------------------------------------------------------------

function parseDockerfile(file, content, b) {
  const lines = content.split(/\r?\n/);
  const images = [];
  lines.forEach((raw, i) => {
    const m = stripComment(raw).trim().match(/^FROM\s+(\S+)/i);
    if (m) images.push({ image: m[1], line: i + 1 });
  });
  if (!images.length) return false;

  // Attach to the compose/k8s node whose build context this Dockerfile sits
  // in, when we can tell; otherwise it stands alone as a build input.
  const dir = file.path.split("/").slice(0, -1).join("/");
  b.dockerfiles = b.dockerfiles || [];
  b.dockerfiles.push({ path: file.path, dir, images });
  return true;
}

// ---------------------------------------------------------------------------
// Kubernetes manifests
// ---------------------------------------------------------------------------

function parseK8s(file, content, b) {
  // Manifests are frequently multi-document; each `---` starts a new one.
  const docs = content.split(/^---\s*$/m);
  let offset = 0;
  let matched = false;

  for (const doc of docs) {
    const startLine = offset + 1;
    offset += doc.split(/\r?\n/).length;

    const kindM = doc.match(/^kind:\s*(\S+)/m);
    const nameM = doc.match(/^\s{2}name:\s*(\S+)/m);
    if (!kindM || !nameM) continue;
    const kind = kindM[1];
    const name = unquote(nameM[1]);
    const lineOf = (needle) => {
      const idx = doc.split(/\r?\n/).findIndex((l) => l.includes(needle));
      return idx >= 0 ? startLine + idx : startLine;
    };

    if (kind === "Deployment" || kind === "StatefulSet") {
      matched = true;
      const id = `k8s:${name}`;
      b.addCluster(id, { name, kind: "k8s_workload", file: file.path, line: lineOf(`name: ${name}`) });
      const node = b.addNode(id, {
        kind: kind === "StatefulSet" ? "database" : "service",
        name, cluster: id, file: file.path, line: lineOf(`name: ${name}`),
      });
      const image = doc.match(/^\s*-?\s*image:\s*(\S+)/m);
      if (image) {
        node.image = unquote(image[1]);
        node.imageEvidence = evidence(file.path, lineOf(image[0].trim()));
      }
      const replicas = doc.match(/^\s*replicas:\s*(\d+)/m);
      if (replicas) node.scaleEvidence = evidence(file.path, lineOf(replicas[0].trim()));
    }

    if (kind === "Service") {
      matched = true;
      const typeM = doc.match(/^\s*type:\s*(\S+)/m);
      const type = typeM ? unquote(typeM[1]) : "ClusterIP";
      const target = b.nodes.get(`k8s:${name}`);
      if (target && (type === "LoadBalancer" || type === "NodePort")) {
        target.publiclyReachable = true;
        target.publicEvidence = evidence(file.path, lineOf(typeM[0].trim()));
      }
    }

    if (kind === "Ingress") {
      matched = true;
      const id = `k8s:${name}`;
      b.addCluster(id, { name, kind: "k8s_ingress", file: file.path, line: lineOf(`name: ${name}`) });
      const node = b.addNode(id, { kind: "service", name, cluster: id, file: file.path, line: lineOf(`name: ${name}`) });
      node.isGateway = true;
      node.publiclyReachable = true;
      node.publicEvidence = evidence(file.path, lineOf(`name: ${name}`));
    }
  }
  return matched;
}

// ---------------------------------------------------------------------------
// Terraform — a deliberately small set of resource types
// ---------------------------------------------------------------------------

const TF_KINDS = {
  aws_s3_bucket:            "bucket",
  aws_db_instance:          "database",
  aws_rds_cluster:          "database",
  aws_dynamodb_table:       "database",
  aws_elasticache_cluster:  "database",
  aws_sqs_queue:            "queue",
  aws_lambda_function:      "service",
  google_storage_bucket:    "bucket",
  google_sql_database_instance: "database",
};

function parseTerraform(file, content, b) {
  const lines = content.split(/\r?\n/);
  let matched = false;
  lines.forEach((raw, i) => {
    const m = stripComment(raw).trim().match(/^resource\s+"([A-Za-z0-9_]+)"\s+"([A-Za-z0-9_-]+)"/);
    if (!m) return;
    const kind = TF_KINDS[m[1]];
    if (!kind) return;
    matched = true;
    const id = `tf:${m[1]}.${m[2]}`;
    const node = b.addNode(id, { kind, name: m[2], cluster: null, file: file.path, line: i + 1 });
    node.terraformType = m[1];
    // Lifecycle/retention is checked by the cost lens; record whether the
    // block mentions it at all.
    node.tfBlockStart = i + 1;
  });
  if (matched) {
    b.terraform = b.terraform || [];
    b.terraform.push({ path: file.path, content });
  }
  return matched;
}

// ---------------------------------------------------------------------------
// Jekyll static site
// ---------------------------------------------------------------------------

function parseJekyll(file, content, b) {
  const lines = content.split(/\r?\n/);
  const titleIdx = lines.findIndex((l) => /^(title|url|baseurl):/.test(l.trim()));
  const line = titleIdx >= 0 ? titleIdx + 1 : 1;
  const dir  = file.path.split("/").slice(0, -1).join("/") || "site";
  const name = basename(dir) || "site";
  const id   = `site:${name}`;
  b.addCluster(id, { name, kind: "static_site", file: file.path, line });
  const node = b.addNode(id, { kind: "static_site", name, cluster: id, file: file.path, line });
  node.publiclyReachable = true;
  node.publicEvidence = evidence(file.path, line);
  node.servesStatic = true;
  return true;
}

// ---------------------------------------------------------------------------
// Source files — cross-cluster imports and outbound HTTP
// ---------------------------------------------------------------------------

const SOURCE_RE = /\.(js|mjs|cjs|jsx|ts|tsx)$/;
const IMPORT_RE = /(?:^|\s)(?:import\s[\s\S]{0,200}?from\s*|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/;
const URL_RE    = /["'`](https?:\/\/([A-Za-z0-9._-]+)(?::\d+)?[^"'`]*)["'`]/g;

// Hosts that are infrastructure noise rather than architecture.
const IGNORED_HOSTS = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|example\.com|example\.org|schema\.org|www\.w3\.org)$/i;

// Markers that some form of authentication exists on a code path. Used only
// to decide whether we have ANY evidence of auth in a cluster we actually
// read — never to claim a specific route is protected, which static text
// matching cannot establish.
const AUTH_MARKER_RE = /\b(requireAuth|requireAdmin|authenticate|authorize|isAuthenticated|passport|ensureLoggedIn|verifyJWT|checkAuth|@?PreAuthorize|auth_required|login_required)\b/;

function parseSource(file, content, b, pending) {
  const lines = content.split(/\r?\n/);

  pending.sourceFiles.push(file.path);
  if (AUTH_MARKER_RE.test(content)) pending.authFiles.push(file.path);

  lines.forEach((raw, i) => {
    const line = i + 1;

    const imp = raw.match(IMPORT_RE);
    if (imp && imp[1].startsWith(".")) {
      pending.imports.push({ from: file.path, spec: imp[1], line });
    }

    URL_RE.lastIndex = 0;
    let m;
    while ((m = URL_RE.exec(raw)) !== null) {
      const host = m[2];
      if (IGNORED_HOSTS.test(host)) continue;
      pending.urls.push({ from: file.path, host, url: m[1], line });
    }
  });
  return true;
}

// ---------------------------------------------------------------------------
// Secrets in env files and manifests
// ---------------------------------------------------------------------------

const SECRET_KEY_RE = /(SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIAL)/i;
// Values that are obviously not a real secret. A committed placeholder is a
// template, not a leak, and flagging it teaches people to ignore the rule.
const PLACEHOLDER_RE = /^(|""|''|changeme|change_me|your[-_].*|<.*>|\$\{.*\}|\$[A-Za-z_].*|x{3,}|\.{3,}|placeholder|example|todo|replace[-_]?me|secret|password|null|none|test)$/i;

function scanSecrets(file, content) {
  const hits = [];
  content.split(/\r?\n/).forEach((raw, i) => {
    const s = stripComment(raw).trim();
    const m = s.match(/^(?:export\s+)?([A-Za-z0-9_.-]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIAL)[A-Za-z0-9_.-]*)\s*[:=]\s*(.*)$/i);
    if (!m) return;
    if (!SECRET_KEY_RE.test(m[1])) return;
    const value = unquote(m[2].trim());
    if (PLACEHOLDER_RE.test(value)) return;
    if (value.length < 8) return;
    hits.push({ key: m[1], line: i + 1, file: file.path });
  });
  return hits;
}

const ENV_FILE_RE  = /(^|\/)\.env(\..+)?$|\.env$/i;
const MANIFEST_RE  = /\.(ya?ml|toml|tf|json|env)$/i;

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function buildGraph(files) {
  const b = makeBuilder();
  const pending = { imports: [], urls: [], sourceFiles: [], authFiles: [] };
  const secrets = [];

  for (const file of files) {
    const name = basename(file.path);
    const content = file.content || "";
    let handled = false;

    if (name === "wrangler.toml")                                handled = parseWrangler(file, content, b);
    else if (/^docker-compose\.ya?ml$|^compose\.ya?ml$/.test(name)) handled = parseCompose(file, content, b);
    else if (/^Dockerfile/.test(name))                           handled = parseDockerfile(file, content, b);
    else if (/\.tf$/.test(name))                                 handled = parseTerraform(file, content, b);
    else if (name === "_config.yml" || name === "_config.yaml")  handled = parseJekyll(file, content, b);
    else if (/\.ya?ml$/.test(name) && /^kind:\s*\S+/m.test(content)) handled = parseK8s(file, content, b);
    else if (SOURCE_RE.test(name))                               handled = parseSource(file, content, b, pending);

    if (ENV_FILE_RE.test(file.path) || MANIFEST_RE.test(name)) {
      secrets.push(...scanSecrets(file, content));
    }

    (handled ? b.coverage.analyzed : b.coverage.skipped).push(file.path);
  }

  resolveSourceEdges(b, pending);
  assignSharedResources(b);

  const nodes = [...b.nodes.values()];
  for (const cluster of b.clusters.values()) {
    cluster.nodes = nodes.filter((n) => n.cluster === cluster.id).map((n) => n.id);
  }

  return {
    nodes,
    edges: dedupeEdges(b.edges),
    clusters: [...b.clusters.values()],
    secrets,
    dockerfiles: b.dockerfiles || [],
    coverage: {
      filesAnalyzed: b.coverage.analyzed.length,
      filesSkipped:  b.coverage.skipped.length,
      // Named explicitly so a caller can see WHICH inputs contributed nothing,
      // rather than inferring completeness from a graph that looks plausible.
      skipped: b.coverage.skipped.slice(0, 50),
      truncatedSkippedList: b.coverage.skipped.length > 50,
    },
  };
}

/**
 * Turn per-file source facts into edges, once every cluster is known.
 *
 * Imports only become edges when they CROSS a cluster boundary. A full
 * intra-service import graph would bury the architecture in hundreds of edges
 * nobody can read, and the question this analyzer answers is about services,
 * not modules.
 */
function resolveSourceEdges(b, pending) {
  const clusterForPath = makeClusterResolver(b);

  // Which clusters did we actually read source for, and which showed any sign
  // of authentication. The security lens needs both: "no auth found" only
  // means something for a cluster whose code we opened.
  for (const p of pending.sourceFiles) {
    const id = clusterForPath(p);
    if (!id) continue;
    const cluster = b.clusters.get(id);
    if (cluster) cluster.sourceFilesRead = (cluster.sourceFilesRead || 0) + 1;
  }
  for (const p of pending.authFiles) {
    const id = clusterForPath(p);
    if (!id) continue;
    const cluster = b.clusters.get(id);
    if (cluster) {
      cluster.authMarkers = (cluster.authMarkers || 0) + 1;
      cluster.authEvidence = cluster.authEvidence || p;
    }
  }

  for (const imp of pending.imports) {
    const fromCluster = clusterForPath(imp.from);
    if (!fromCluster) continue;
    const resolved = resolveRelative(imp.from, imp.spec);
    const toCluster = clusterForPath(resolved);
    if (!toCluster || toCluster === fromCluster) continue;
    b.addEdge(fromCluster, toCluster, "import", { file: imp.from, line: imp.line });
  }

  const nodesByName = new Map();
  for (const node of b.nodes.values()) nodesByName.set(node.name, node.id);

  for (const u of pending.urls) {
    const fromCluster = clusterForPath(u.from);
    if (!fromCluster) continue;

    // A URL whose host matches a service we know about is an internal call;
    // anything else is a third party the system depends on.
    const internal = nodesByName.get(u.host);
    if (internal && internal !== fromCluster) {
      b.addEdge(fromCluster, internal, "http", { file: u.from, line: u.line, via: "fetch" });
      continue;
    }
    const id = `ext:${u.host}`;
    b.addNode(id, { kind: "external_api", name: u.host, cluster: null, file: u.from, line: u.line });
    b.addEdge(fromCluster, id, "http", { file: u.from, line: u.line, via: "fetch" });
  }
}

/**
 * Collapse edges that describe the same relationship twice.
 *
 * A wrangler config re-declares every binding per environment, so a single
 * "this Worker uses this database" fact arrives three times with three line
 * numbers. Left alone that inflates the chatty-edge rule into flagging
 * ordinary configuration. Structural edges (binding/queue/cron/import) are
 * therefore collapsed to one per relationship, keeping the first evidence and
 * counting the rest; HTTP edges are collapsed only on an exact repeat of the
 * same call site, because for those the number of distinct call sites IS the
 * signal the speed lens reads.
 */
function dedupeEdges(edges) {
  const out = [];
  const byKey = new Map();
  for (const edge of edges) {
    const structural = edge.kind !== "http";
    const key = structural
      ? `${edge.from}|${edge.to}|${edge.kind}`
      : `${edge.from}|${edge.to}|${edge.kind}|${edge.evidence}`;
    const seen = byKey.get(key);
    if (seen) {
      seen.occurrences = (seen.occurrences || 1) + 1;
      if (!seen.alsoAt) seen.alsoAt = [];
      if (seen.alsoAt.length < 5 && edge.evidence !== seen.evidence) seen.alsoAt.push(edge.evidence);
      continue;
    }
    const copy = { ...edge };
    byKey.set(key, copy);
    out.push(copy);
  }
  return out;
}

/** Longest-prefix match from a file path to the cluster whose directory contains it. */
function makeClusterResolver(b) {
  return (p) => {
    let best = null;
    for (const cluster of b.clusters.values()) {
      const evidencePath = (cluster.evidence || "").split(":")[0];
      const dir = evidencePath.split("/").slice(0, -1).join("/");
      if (!dir) continue;
      if (p === evidencePath || p.startsWith(dir + "/")) {
        if (!best || dir.length > best.dir.length) best = { id: cluster.id, dir };
      }
    }
    return best ? best.id : null;
  };
}

function resolveRelative(fromPath, spec) {
  const parts = fromPath.split("/").slice(0, -1);
  for (const seg of spec.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

/**
 * A resource bound by more than one cluster belongs to none of them. Marking
 * it shared is what lets the security lens say "this datastore is reachable
 * from more than its owning service" with evidence rather than suspicion.
 */
function assignSharedResources(b) {
  const inboundClusters = new Map();
  for (const edge of b.edges) {
    const from = b.nodes.get(edge.from);
    const to   = b.nodes.get(edge.to);
    if (!from || !to) continue;
    const owner = from.cluster || from.id;
    if (!inboundClusters.has(to.id)) inboundClusters.set(to.id, new Set());
    inboundClusters.get(to.id).add(owner);
  }
  for (const [nodeId, owners] of inboundClusters) {
    const node = b.nodes.get(nodeId);
    if (!node) continue;
    node.inboundClusters = [...owners];
    if (owners.size > 1) node.shared = true;
  }
}
