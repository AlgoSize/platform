// Kubernetes manifest adapter.
//
// Deterministic line-scanning, in the same house style as
// analyzers/architecture/graph.js: no YAML dependency, no eval, no kubectl, no
// cluster access. It reads the document as text and never executes anything
// from it.
//
// Why hand-rolled rather than a YAML library: the manifests this needs to
// understand are a narrow, highly regular subset (kind / metadata.name /
// replicas / containers[].resources), and a full YAML parser is a much larger
// attack surface — YAML has anchors, merge keys and tags that have produced
// real RCEs in other ecosystems. Reading only the shapes we price keeps the
// blast radius of a hostile manifest to "we misread a number".
//
// Supported: Deployment, StatefulSet, DaemonSet, Job, CronJob, Pod.

import {
  EstimatorError, rejectSecrets, parseCpuToMilli, parseMemoryToMilliGiB, MILLI,
} from "../spec.js";

const WORKLOAD_KINDS = Object.freeze({
  Deployment: { replicaField: "replicas", defaultReplicas: 1 },
  StatefulSet: { replicaField: "replicas", defaultReplicas: 1 },
  DaemonSet: { replicaField: null, defaultReplicas: 1 },
  Job: { replicaField: "parallelism", defaultReplicas: 1 },
  CronJob: { replicaField: "parallelism", defaultReplicas: 1 },
  Pod: { replicaField: null, defaultReplicas: 1 },
});

const indentOf = (line) => line.length - line.replace(/^\s*/, "").length;
const stripComment = (line) => {
  // Only strip a '#' that is not inside quotes — a value like "a#b" is legal.
  let inS = false, inD = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === "#" && !inS && !inD) return line.slice(0, i);
  }
  return line;
};
const unquote = (v) => {
  const t = String(v).trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
};

/** Split a multi-document YAML stream on `---` at column zero. */
function splitDocuments(text) {
  const docs = [];
  let current = [];
  for (const raw of text.split(/\r?\n/)) {
    if (/^---\s*$/.test(raw)) {
      if (current.length) docs.push(current.join("\n"));
      current = [];
    } else {
      current.push(raw);
    }
  }
  if (current.length) docs.push(current.join("\n"));
  return docs.filter((d) => d.trim());
}

/**
 * Scalar for a key at any depth, optionally under a parent key.
 * Returns the first match — manifests do not repeat these at one level.
 */
function findScalar(lines, key, { minIndent = 0 } = {}) {
  const re = new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`);
  for (const raw of lines) {
    const line = stripComment(raw);
    if (indentOf(line) < minIndent) continue;
    const m = re.exec(line);
    if (m && m[1].trim()) return unquote(m[1]);
  }
  return null;
}

/**
 * Every container's resources block.
 *
 * Walks the `containers:` (and `initContainers:`) list items by indentation,
 * so a container's `resources.requests.cpu` is attributed to that container
 * and not to its neighbour.
 */
function extractContainers(lines) {
  const containers = [];
  let i = 0;
  while (i < lines.length) {
    const line = stripComment(lines[i]);
    if (!/^\s*(?:initContainers|containers)\s*:\s*$/.test(line)) { i++; continue; }
    const listIndent = indentOf(line);
    i++;
    let current = null;
    while (i < lines.length) {
      const raw = stripComment(lines[i]);
      if (raw.trim() === "") { i++; continue; }
      const ind = indentOf(raw);
      if (ind <= listIndent && !/^\s*-\s/.test(raw)) break;      // left the list
      if (/^\s*-\s/.test(raw) && ind <= listIndent + 2) {
        if (current) containers.push(current);
        current = { name: null, requests: {}, limits: {} };
        const nameOnDash = /^\s*-\s+name\s*:\s*(.+)$/.exec(raw);
        if (nameOnDash) current.name = unquote(nameOnDash[1]);
        i++;
        continue;
      }
      if (current) {
        const nm = /^\s*name\s*:\s*(.+)$/.exec(raw);
        if (nm && !current.name) current.name = unquote(nm[1]);
        // resources.requests.cpu / limits.memory — matched by their enclosing key
        const res = /^\s*(requests|limits)\s*:\s*$/.exec(raw);
        if (res) {
          const bucket = res[1];
          const blockIndent = ind;
          let j = i + 1;
          while (j < lines.length) {
            const inner = stripComment(lines[j]);
            if (inner.trim() === "") { j++; continue; }
            if (indentOf(inner) <= blockIndent) break;
            const kv = /^\s*(cpu|memory)\s*:\s*(.+)$/.exec(inner);
            if (kv) current[bucket][kv[1]] = unquote(kv[2]);
            j++;
          }
          i = j;
          continue;
        }
      }
      i++;
    }
    if (current) containers.push(current);
  }
  return containers;
}

/**
 * Parse Kubernetes manifests into ResourceSpec[].
 *
 * @param {string} text
 * @param {object} opts  { capacityBasis: "requests" | "limits" }
 */
export function adaptKubernetes(text, opts = {}) {
  if (typeof text !== "string" || !text.trim()) {
    throw new EstimatorError("empty_input", "No Kubernetes manifest content was provided.", "content");
  }
  rejectSecrets(text);

  const basis = opts.capacityBasis === "limits" ? "limits" : "requests";
  const resources = [];
  const warnings = [];

  for (const doc of splitDocuments(text)) {
    const lines = doc.split("\n");
    const kind = findScalar(lines, "kind");
    if (!kind) {
      warnings.push({ code: "document_without_kind", message: "A document had no `kind` and was skipped." });
      continue;
    }
    const shape = WORKLOAD_KINDS[kind];
    if (!shape) {
      warnings.push({ code: "unsupported_kind", message: `Kind "${kind.slice(0, 40)}" is not a priceable workload and was skipped.` });
      continue;
    }

    const name = findScalar(lines, "name") || kind.toLowerCase();
    let replicas = shape.defaultReplicas;
    if (shape.replicaField) {
      const raw = findScalar(lines, shape.replicaField);
      if (raw !== null) {
        const n = Number(raw);
        if (Number.isInteger(n) && n >= 0) replicas = n;
        else warnings.push({ code: "unreadable_replicas", message: `Replica count for "${name}" was not an integer; defaulted to ${shape.defaultReplicas}.` });
      } else {
        warnings.push({ code: "replicas_defaulted", message: `No ${shape.replicaField} declared for "${name}"; assumed ${shape.defaultReplicas}.` });
      }
    }
    if (kind === "DaemonSet") {
      warnings.push({ code: "daemonset_node_count_unknown", message: `"${name}" is a DaemonSet: one Pod per node, and the node count is not in the manifest. Counted as 1 — multiply by your node count.` });
    }
    if (replicas === 0) {
      warnings.push({ code: "scaled_to_zero", message: `"${name}" declares 0 replicas and consumes nothing while scaled down.` });
      continue;
    }

    const containers = extractContainers(lines);
    if (containers.length === 0) {
      warnings.push({ code: "no_containers_found", message: `No container definitions were found for "${name}", so it cannot be priced.` });
      continue;
    }

    containers.forEach((c, idx) => {
      const chosen = c[basis];
      const other = c[basis === "requests" ? "limits" : "requests"];
      let cpuRaw = chosen.cpu, memRaw = chosen.memory, usedFallback = false;

      // Fall back to the other bucket rather than pricing at zero, and say so.
      if (cpuRaw === undefined && other.cpu !== undefined) { cpuRaw = other.cpu; usedFallback = true; }
      if (memRaw === undefined && other.memory !== undefined) { memRaw = other.memory; usedFallback = true; }

      const id = `${kind}/${name}/${c.name || `container-${idx + 1}`}`;
      if (cpuRaw === undefined && memRaw === undefined) {
        warnings.push({ code: "container_without_resources", message: `Container "${id}" declares neither ${basis} nor the opposite bucket, so it has no capacity to price. Reported as unsupported rather than free.` });
        resources.push({ id, type: "container", quantity: replicas, capacityBasis: basis });
        return;
      }
      if (usedFallback) {
        warnings.push({ code: "capacity_basis_fallback", message: `Container "${id}" had no ${basis} for one or more dimensions; the opposite bucket was used instead.` });
      }

      resources.push({
        id,
        type: "container",
        quantity: replicas,
        cpuMilli: parseCpuToMilli(cpuRaw, `${id}.cpu`) || 0,
        memoryMilliGiB: parseMemoryToMilliGiB(memRaw, `${id}.memory`) || 0,
        capacityBasis: basis,
      });
    });
  }

  if (resources.length === 0) {
    throw new EstimatorError("empty_input", "No priceable Kubernetes workloads were found. Supported kinds: " + Object.keys(WORKLOAD_KINDS).join(", ") + ".", "content");
  }
  return { resources, warnings };
}
