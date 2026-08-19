// Docker Compose adapter.
//
// Same house style as adapters/k8s.js: deterministic line scanning, no YAML
// dependency, no eval, no Docker daemon, no registry lookups. The file is read
// as text and nothing in it is ever executed or resolved.
//
// ---------------------------------------------------------------------------
// THE UNIT TRAP THIS FILE EXISTS TO AVOID
// ---------------------------------------------------------------------------
//
// Compose and Kubernetes both spell memory limits with a `M`/`G` suffix, and
// they mean DIFFERENT THINGS:
//
//   Kubernetes   512M  = 512 × 10^6 bytes  (decimal; 512Mi is the binary one)
//   Compose      512M  = 512 × 2^20 bytes  (binary — Docker's byte-value units
//                                           are 1024-based, and there is no
//                                           `Mi` spelling in Compose at all)
//
// Reusing spec.js's parseMemoryToMilliGiB here — which correctly implements the
// Kubernetes rule — would under-read every Compose memory limit by ~4.8%, and
// under-read a `1G` limit by ~7%. It would also be invisible: the number is
// plausible, just wrong. So this adapter carries its own byte parser, and the
// k8s parser is deliberately NOT imported.
//
// Supported: the `services:` block, `deploy.resources.{limits,reservations}`
// (Compose spec / v3), and the legacy v2 service-level `cpus:` / `mem_limit:`.

import {
  EstimatorError, rejectSecrets, parseCpuToMilli, mulDiv, MILLI,
} from "../spec.js";

const BYTES_PER_GIB = 1024 * 1024 * 1024;

// Docker byte-value suffixes, all 1024-based. Bare numbers are bytes, which
// matches `docker run --memory=536870912`.
const BYTE_UNITS = Object.freeze({
  b: 1,
  k: 1024,          kb: 1024,
  m: 1024 ** 2,     mb: 1024 ** 2,
  g: 1024 ** 3,     gb: 1024 ** 3,
});

const indentOf = (line) => line.length - line.replace(/^\s*/, "").length;

const stripComment = (line) => {
  // Only strip a '#' outside quotes — an image tag or command can contain one.
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

/**
 * Compose memory value → milli-GiB. See the unit-trap note at the top.
 *
 * Throws rather than guessing: a memory limit we cannot read is a resource we
 * would otherwise silently price at zero.
 */
export function parseComposeMemoryToMilliGiB(raw, field = "memory") {
  if (raw === undefined || raw === null || raw === "") return null;
  const t = String(raw).trim().toLowerCase();
  const m = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/.exec(t);
  if (!m) {
    throw new EstimatorError("invalid_memory_quantity", "Memory value is not a Compose byte value (e.g. 512m, 1g, 536870912).", field);
  }
  const amount = Number(m[1]);
  const unit = m[2] === "" ? "b" : m[2];
  const multiplier = BYTE_UNITS[unit];
  if (!Number.isFinite(amount) || multiplier === undefined) {
    throw new EstimatorError("invalid_memory_quantity", "Memory unit is not one of b, k/kb, m/mb, g/gb.", field);
  }
  return mulDiv(amount * multiplier, MILLI, BYTES_PER_GIB);
}

/**
 * The lines of the block introduced by `key:` (a key with nothing after the
 * colon), searched only at or below `minIndent`. Returns null when absent.
 */
function blockFor(lines, key, minIndent = 0) {
  const re = new RegExp(`^\\s*${key}\\s*:\\s*$`);
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]);
    if (line.trim() === "" || indentOf(line) < minIndent) continue;
    if (!re.test(line)) continue;
    const ind = indentOf(line);
    const out = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = stripComment(lines[j]);
      if (l.trim() === "") { out.push(l); continue; }
      if (indentOf(l) <= ind) break;
      out.push(l);
    }
    return out;
  }
  return null;
}

/** Follow a chain of nested block keys, e.g. ["deploy","resources","limits"]. */
function blockAtPath(lines, path) {
  let cur = lines;
  for (const key of path) {
    cur = blockFor(cur, key);
    if (cur === null) return null;
  }
  return cur;
}

/** First scalar `key: value` in these lines, at exactly `indent` if given. */
function scalarIn(lines, key, indent = null) {
  const re = new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`);
  for (const raw of lines) {
    const line = stripComment(raw);
    if (line.trim() === "") continue;
    if (indent !== null && indentOf(line) !== indent) continue;
    const m = re.exec(line);
    if (m && m[1].trim()) return unquote(m[1]);
  }
  return null;
}

/**
 * Split the `services:` block into one entry per service.
 *
 * Service names are the keys at the block's own first child indent; anything
 * deeper belongs to the service above it. Keying off indentation rather than
 * a name pattern is what stops `image:` or `deploy:` from being mistaken for
 * a sibling service.
 */
function splitServices(serviceLines) {
  const meaningful = serviceLines.filter((l) => stripComment(l).trim() !== "");
  if (meaningful.length === 0) return [];
  const childIndent = indentOf(stripComment(meaningful[0]));

  const services = [];
  let current = null;
  for (const raw of serviceLines) {
    const line = stripComment(raw);
    if (line.trim() === "") { if (current) current.lines.push(line); continue; }
    const ind = indentOf(line);
    if (ind === childIndent) {
      const m = /^\s*([A-Za-z0-9._-]+)\s*:\s*(.*)$/.exec(line);
      if (m) {
        if (current) services.push(current);
        current = { name: m[1], lines: [], childIndent: null };
        continue;
      }
    }
    if (current) current.lines.push(line);
  }
  if (current) services.push(current);

  for (const s of services) {
    const first = s.lines.find((l) => l.trim() !== "");
    s.childIndent = first ? indentOf(first) : null;
  }
  return services;
}

/**
 * Parse a docker-compose file into ResourceSpec[].
 *
 * @param {string} text
 * @param {object} opts  { capacityBasis: "requests" | "limits" }
 *   "requests" reads `deploy.resources.reservations` (the guaranteed floor,
 *   the closest Compose analogue to a Kubernetes request); "limits" reads
 *   `deploy.resources.limits`.
 */
export function adaptCompose(text, opts = {}) {
  if (typeof text !== "string" || !text.trim()) {
    throw new EstimatorError("empty_input", "No Compose file content was provided.", "content");
  }
  rejectSecrets(text);

  const basis = opts.capacityBasis === "limits" ? "limits" : "requests";
  // Which Compose block the chosen basis maps onto, and its opposite.
  const primaryBlock = basis === "limits" ? "limits" : "reservations";
  const fallbackBlock = basis === "limits" ? "reservations" : "limits";

  const lines = text.split(/\r?\n/);
  const serviceBlock = blockFor(lines, "services");
  if (serviceBlock === null) {
    throw new EstimatorError("malformed_document", "No `services:` block was found. This does not look like a Compose file.", "content");
  }

  const services = splitServices(serviceBlock);
  if (services.length === 0) {
    throw new EstimatorError("empty_input", "The `services:` block is empty.", "content");
  }

  const resources = [];
  const warnings = [];

  for (const svc of services) {
    const sl = svc.lines;

    // Replicas: `deploy.replicas`, default 1. Compose's own default when the
    // key is absent is a single container, so this one is not an assumption
    // worth warning about the way a missing k8s replica count is.
    let replicas = 1;
    const deploy = blockFor(sl, "deploy");
    if (deploy) {
      const raw = scalarIn(deploy, "replicas");
      if (raw !== null) {
        const n = Number(raw);
        if (Number.isInteger(n) && n >= 0) replicas = n;
        else warnings.push({ code: "unreadable_replicas", message: `Replica count for service "${svc.name}" was not an integer; assumed 1.` });
      }
    }
    if (replicas === 0) {
      warnings.push({ code: "scaled_to_zero", message: `Service "${svc.name}" declares 0 replicas and consumes nothing while scaled down.` });
      continue;
    }

    // Capacity, preferring the requested basis and falling back to the other
    // block rather than pricing at zero.
    const primary = blockAtPath(sl, ["deploy", "resources", primaryBlock]);
    const fallback = blockAtPath(sl, ["deploy", "resources", fallbackBlock]);

    let cpuRaw = primary ? scalarIn(primary, "cpus") : null;
    let memRaw = primary ? scalarIn(primary, "memory") : null;
    let usedFallback = false;
    if (cpuRaw === null && fallback) { const v = scalarIn(fallback, "cpus"); if (v !== null) { cpuRaw = v; usedFallback = true; } }
    if (memRaw === null && fallback) { const v = scalarIn(fallback, "memory"); if (v !== null) { memRaw = v; usedFallback = true; } }

    // Legacy Compose v2 spelling, at the service's own indent so a nested
    // `cpus:` under deploy.resources is not double-counted here.
    let usedLegacy = false;
    if (cpuRaw === null) {
      const v = scalarIn(sl, "cpus", svc.childIndent);
      if (v !== null) { cpuRaw = v; usedLegacy = true; }
    }
    if (memRaw === null) {
      const v = scalarIn(sl, "mem_limit", svc.childIndent);
      if (v !== null) { memRaw = v; usedLegacy = true; }
    }

    const id = `service/${svc.name}`;

    if (cpuRaw === null && memRaw === null) {
      // The common case for a hand-written Compose file: no resource limits at
      // all. Compose treats that as "unbounded, take what the host has", which
      // is precisely the thing this estimator cannot infer a price for. It is
      // reported as unsupported so it shows up as a gap, never as free.
      warnings.push({
        code: "service_without_resources",
        message: `Service "${svc.name}" declares no CPU or memory limits. Compose lets such a service use whatever the host has, so there is no declared capacity to price — enter it manually to include it.`,
      });
      resources.push({ id, type: "container", quantity: replicas, capacityBasis: basis });
      continue;
    }
    if (usedFallback) {
      warnings.push({
        code: "capacity_basis_fallback",
        message: `Service "${svc.name}" had no ${primaryBlock} for one or more dimensions; ${fallbackBlock} was used instead.`,
      });
    }
    if (usedLegacy) {
      warnings.push({
        code: "legacy_compose_limits",
        message: `Service "${svc.name}" uses the Compose v2 service-level \`cpus\`/\`mem_limit\` keys rather than \`deploy.resources\`. They were read as its capacity.`,
      });
    }

    resources.push({
      id,
      type: "container",
      quantity: replicas,
      cpuMilli: parseCpuToMilli(cpuRaw, `${id}.cpus`) || 0,
      memoryMilliGiB: parseComposeMemoryToMilliGiB(memRaw, `${id}.memory`) || 0,
      capacityBasis: basis,
    });
  }

  if (resources.length === 0) {
    throw new EstimatorError("empty_input", "No priceable services were found in the Compose file.", "content");
  }

  // Said once per file rather than once per service: Compose describes what
  // runs, never where. Every provider comparison downstream is therefore
  // "what would these containers cost on X", not a reading of a real bill.
  warnings.push({
    code: "compose_has_no_infrastructure",
    message: "A Compose file describes containers, not the machines behind them. Storage volumes, managed databases, load balancers and egress are not declared in it and are not included in this estimate.",
  });

  return { resources, warnings };
}
