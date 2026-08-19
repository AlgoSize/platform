// Canonical secret detection — one definition of "this string is a credential".
//
// Public surface:
//   detectSecrets(text)   -> [{ type, severity, line, value, recommendation }]
//   assertNoSecrets(text) -> throws SecretDetectedError (safe: names, never values)
//   redactSecrets(text)   -> text with every detected credential replaced
//
// ---------------------------------------------------------------------------
// WHY graph.js IS NOT ROUTED THROUGH THIS MODULE
// ---------------------------------------------------------------------------
//
// There are two secret detectors in this codebase and they are NOT duplicates.
// This one recognises credential VALUES by their published format (an AWS key
// really does start `AKIA` and run 20 chars). architecture/graph.js recognises
// a KEY NAME that suggests a secret and then judges whether the value looks
// real. The two disagree, deliberately, in four ways:
//
//   comments      here: scanned — a leaked secret in a comment is still leaked
//                 graph: stripped before matching
//   placeholders  here: SUBSTRING match anywhere in the line
//                 graph: ANCHORED ^…$ against the whole value
//   list contents here: process.env, YOUR_, fake, fixme, …
//                 graph: test, null, none, secret, password, …
//   quoting       here: the generic pattern requires quotes
//                 graph: bare values accepted (it reads .env files)
//
// Merging the placeholder lists would change results in BOTH directions. The
// concrete regression: `const apiKey = "test1234"` is flagged here today and
// would stop being flagged, because "test" is in graph's list. That is a
// critical detector getting quietly weaker, which is exactly the failure this
// codebase's logging rules exist to prevent.
//
// scripts/test-secrets-baseline.mjs pins both behaviours, including the
// disagreements. If someone later unifies them, those tests name which side
// moved instead of letting the change pass silently.

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

/**
 * High-confidence credential formats. Each entry is a published prefix + a
 * length the issuer guarantees, so a match is a credential rather than a guess
 * — which is why these are `critical` without needing a value heuristic.
 *
 * Consumers MUST NOT hold these regex objects across calls: they carry /g and
 * therefore `lastIndex`. Use `scanLine()`, which resets before every use.
 */
export const SECRET_PATTERNS = [
  {
    type: "hardcoded_aws_access_key",
    severity: "critical",
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
    recommendation: "Rotate this AWS access key immediately and store credentials in environment variables or AWS Secrets Manager.",
  },
  {
    type: "hardcoded_github_personal_token",
    severity: "critical",
    regex: /\bghp_[A-Za-z0-9]{36}\b/g,
    recommendation: "Revoke this GitHub PAT at github.com/settings/tokens and inject the token via an environment variable.",
  },
  {
    type: "hardcoded_github_fine_grained_token",
    severity: "critical",
    regex: /\bgithub_pat_[A-Za-z0-9_]{82,}\b/g,
    recommendation: "Revoke this GitHub fine-grained PAT and inject the token via an environment variable.",
  },
  {
    type: "hardcoded_stripe_live_key",
    severity: "critical",
    regex: /\bsk_live_[A-Za-z0-9]{20,}\b/g,
    recommendation: "Roll this Stripe live key in the Stripe dashboard immediately — anyone with this key can charge cards on your account.",
  },
  {
    type: "hardcoded_slack_token",
    severity: "high",
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    recommendation: "Revoke this Slack token in the Slack admin console and inject it via an environment variable.",
  },
];

/** Strings we consider "obviously a placeholder, not a real secret". */
export const PLACEHOLDER_RE = /(\$\{|process\.env|os\.getenv|getenv\s*\(|import\.meta\.env|YOUR_|xxxxx|placeholder|example|fake|<your|<insert|todo|fixme|change[_-]?me|replace[_-]?me)/i;

/** A secret-ish key assigned a quoted literal of plausible length. */
export const GENERIC_SECRET_RE = /(?:api[_-]?key|apikey|access[_-]?token|secret[_-]?key|client[_-]?secret|auth[_-]?token)\s*[:=]\s*["']([^"']{8,})["']/i;

export const GENERIC_SECRET_RECOMMENDATION =
  "Move this credential to an environment variable or secret store; never commit raw secrets to source control.";

/**
 * Field names that must never be submitted to an upload-triggered analyzer,
 * matched on the KEY alone regardless of what the value looks like.
 *
 * Distinct from the patterns above: those ask "is this string a credential?",
 * this asks "is the user handing us a credential-shaped field at all?" — a
 * `kubeconfig:` key is disqualifying even when its value is obviously fake,
 * because accepting it at all would train people to paste real ones.
 */
export const BANNED_CREDENTIAL_KEYS = [
  "aws_access_key_id", "aws_secret_access_key", "aws_session_token",
  "session_token", "client_secret", "private_key", "refresh_token",
  "access_token", "kubeconfig", "credentials", "secret_access_key",
];

const BANNED_KEY_RE = new RegExp(
  `(?:^|[^A-Za-z0-9_])(${BANNED_CREDENTIAL_KEYS.join("|")})(?:[^A-Za-z0-9_]|$)`, "i");

export const REDACTION = "***REDACTED***";

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/**
 * Every credential on one line, in pattern order then generic.
 *
 * Resets `lastIndex` before each pattern, so a caller cannot poison the next
 * caller by abandoning a scan midway — the bug that made these regexes unsafe
 * to export raw.
 */
export function scanLine(text) {
  const out = [];
  if (typeof text !== "string" || text === "") return out;

  for (const pat of SECRET_PATTERNS) {
    pat.regex.lastIndex = 0;
    let m;
    while ((m = pat.regex.exec(text)) !== null) {
      out.push({ type: pat.type, severity: pat.severity, value: m[0], recommendation: pat.recommendation });
    }
  }

  const generic = GENERIC_SECRET_RE.exec(text);
  if (generic && !PLACEHOLDER_RE.test(generic[1]) && !PLACEHOLDER_RE.test(text)) {
    out.push({
      type: "hardcoded_generic_secret",
      severity: null,          // caller decides: comment context downgrades it
      value: generic[1],
      recommendation: GENERIC_SECRET_RECOMMENDATION,
    });
  }
  return out;
}

/** Every credential in a multi-line string, each carrying its 1-based line. */
export function detectSecrets(text) {
  if (typeof text !== "string" || text === "") return [];
  const findings = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const hit of scanLine(lines[i])) findings.push({ ...hit, line: i + 1 });
  }
  return findings;
}

/** line -> Set of raw credential strings, for the redaction pass. */
export function collectSecretsByLine(text) {
  const map = new Map();
  if (typeof text !== "string" || text === "") return map;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const hits = scanLine(lines[i]);
    if (hits.length) map.set(i + 1, new Set(hits.map((h) => h.value)));
  }
  return map;
}

/**
 * Replace every occurrence of the given credentials in a fragment.
 *
 * Longest-first so a longer secret containing a shorter one is replaced whole,
 * rather than the shorter match eating part of it and leaving a readable tail.
 */
export function maskSecrets(fragment, secrets) {
  if (!secrets || secrets.size === 0) return fragment;
  let out = fragment;
  for (const s of Array.from(secrets).sort((a, b) => b.length - a.length)) {
    out = out.split(s).join(REDACTION);
  }
  return out;
}

/** Whole-text redaction: every credential this module can see, removed. */
export function redactSecrets(text) {
  if (typeof text !== "string" || text === "") return text;
  const all = new Set(detectSecrets(text).map((f) => f.value));
  return maskSecrets(text, all);
}

// ---------------------------------------------------------------------------
// Rejection
// ---------------------------------------------------------------------------

/**
 * Thrown when a caller submits something containing credentials.
 *
 * `keys` and `lines` are safe to surface and to log. There is deliberately no
 * field carrying a value: the whole point of rejecting the upload is that the
 * credential must not travel any further into the system, and an error object
 * that quotes it back would defeat that at the first log line.
 */
export class SecretDetectedError extends Error {
  constructor(findings) {
    const keys = [...new Set(findings.map((f) => f.key || f.type))];
    super(`Input rejected: credentials detected (${keys.join(", ")}). Remove them and resubmit.`);
    this.name = "SecretDetectedError";
    this.code = "secrets_detected";
    this.findings = findings;
  }
  /** Safe wire form — names and lines only, never values. */
  toSafeJSON() {
    return {
      error: this.code,
      message: "We found credentials in what you submitted, so nothing was processed or stored. " +
               "Remove them and try again — this tool never needs cloud credentials.",
      detected: this.findings.map((f) => ({ key: f.key || f.type, line: f.line })),
    };
  }
}

/**
 * Throw if `text` contains anything credential-shaped.
 *
 * Two independent checks, because they catch different mistakes: a real key
 * pasted by accident (value patterns), and a whole credentials file submitted
 * on purpose (banned key names). Neither ever reads the value into the error.
 */
export function assertNoSecrets(text) {
  if (typeof text !== "string" || text === "") return;
  const findings = [];

  for (const f of detectSecrets(text)) {
    findings.push({ key: f.type, line: f.line });
  }

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = BANNED_KEY_RE.exec(lines[i]);
    if (m) findings.push({ key: m[1].toLowerCase(), line: i + 1 });
  }

  if (findings.length) throw new SecretDetectedError(findings);
}
