// The rule registry — one row per detectable defect.
//
// Detectors emit a `type`. This module is what that type MEANS: the stable
// rule id, the human title, the CWE and OWASP mapping, the category the UI
// groups by, the baseline confidence, and which languages the detection
// actually covers.
//
// It is deliberately separate from the detection logic. The regex tables in
// analyzers/vuln.js and the visitors in sast/ast.js decide WHETHER a line is
// a finding; nothing there should also be deciding what CWE it maps to, or
// the two engines would disagree about the same defect the moment one of
// them is edited. Both go through here, so `command_injection` is CWE-78
// exactly once.
//
// ---------------------------------------------------------------------------
// THE CONFIDENCE FIELD IS LOAD-BEARING
// ---------------------------------------------------------------------------
//
// A scanner that reports everything at "high" trains people to ignore it, and
// the second-worst outcome for a security tool (after missing a real bug) is
// being switched off for noise. So confidence here means something specific:
//
//   high    the match is the defect. A PEM private-key banner is a private
//           key; there is no benign reading.
//   medium  the pattern is nearly always the defect, but a benign spelling
//           exists — a SQL template literal interpolating a constant, say.
//   low     the pattern is a strong hint that needs human eyes. Reserved for
//           structural heuristics (a route with no visible auth guard) where
//           the analyzer cannot see the whole picture.
//
// A rule that would need to be `low` to avoid false positives, and whose
// finding would not be worth reading even when true, does not belong here at
// all. High-signal beats broad coverage.
//
// ---------------------------------------------------------------------------
// GROUPS
// ---------------------------------------------------------------------------
//
// `group` names the DEFECT, not the rule. Two rules sharing a group are two
// ways of detecting one thing (a regex hit and a taint-confirmed sink), and
// schema.js collapses them to one row at the same path+line, keeping the
// stronger claim. Omitting `group` means "never collapse with anything else",
// which is right for secrets: two different leaked keys on one line are two
// separate rotations.

/** Applied to any finding whose type has no registry entry. */
export const DEFAULT_RULE = Object.freeze({
  id: "sast.unregistered",
  title: "Unregistered finding type",
  description:
    "A detector emitted a finding type with no registry entry, so it has no CWE mapping, " +
    "category or remediation guidance. This is a bug in the scanner, not in the scanned code.",
  category: "configuration",
  severity: "info",
  confidence: "low",
  cwe: [],
  owasp: [],
  languages: ["*"],
  module: "pattern-analyzer",
  remediation: "Add a registry entry for this type in analyzers/sast/registry.js.",
});

/**
 * Every rule the scanner can emit.
 *
 * `type` is the wire value the detectors produce and the legacy API has
 * always returned — it cannot be renamed without breaking stored runs, so the
 * prettier `id` is carried alongside rather than replacing it.
 */
export const RULES = Object.freeze([
  // -------------------------------------------------------------- secrets
  {
    type: "hardcoded_aws_access_key",
    id: "secrets.aws.access-key-id",
    title: "AWS access key ID committed to source",
    description: "A string matching AWS's published access-key-ID format (AKIA + 16 uppercase alphanumerics) appears in tracked source.",
    category: "secrets", severity: "critical", confidence: "high",
    cwe: ["CWE-798", "CWE-540"], owasp: ["A07:2021-Identification and Authentication Failures"],
    languages: ["*"], module: "secrets-analyzer",
    remediation: "Rotate the key in IAM immediately, then load credentials from the environment or AWS Secrets Manager. Assume it is compromised: it is in your git history even after you delete the line.",
  },
  {
    type: "hardcoded_github_personal_token",
    id: "secrets.github.pat",
    title: "GitHub personal access token committed to source",
    description: "A string matching GitHub's `ghp_` personal-access-token format appears in tracked source.",
    category: "secrets", severity: "critical", confidence: "high",
    cwe: ["CWE-798"], owasp: ["A07:2021-Identification and Authentication Failures"],
    languages: ["*"], module: "secrets-analyzer",
    remediation: "Revoke the token at github.com/settings/tokens and inject a replacement through an environment variable.",
  },
  {
    type: "hardcoded_github_fine_grained_token",
    id: "secrets.github.fine-grained-pat",
    title: "GitHub fine-grained token committed to source",
    description: "A string matching GitHub's `github_pat_` fine-grained-token format appears in tracked source.",
    category: "secrets", severity: "critical", confidence: "high",
    cwe: ["CWE-798"], owasp: ["A07:2021-Identification and Authentication Failures"],
    languages: ["*"], module: "secrets-analyzer",
    remediation: "Revoke the token at github.com/settings/tokens and inject a replacement through an environment variable.",
  },
  {
    type: "hardcoded_stripe_live_key",
    id: "secrets.stripe.live-key",
    title: "Stripe live secret key committed to source",
    description: "A string matching Stripe's `sk_live_` secret-key format appears in tracked source.",
    category: "secrets", severity: "critical", confidence: "high",
    cwe: ["CWE-798"], owasp: ["A07:2021-Identification and Authentication Failures"],
    languages: ["*"], module: "secrets-analyzer",
    remediation: "Roll the key in the Stripe dashboard now — anyone holding it can charge cards on your account — and read it from a secret store at runtime.",
  },
  {
    type: "hardcoded_slack_token",
    id: "secrets.slack.token",
    title: "Slack token committed to source",
    description: "A string matching Slack's `xox[baprs]-` token format appears in tracked source.",
    category: "secrets", severity: "high", confidence: "high",
    cwe: ["CWE-798"], owasp: ["A07:2021-Identification and Authentication Failures"],
    languages: ["*"], module: "secrets-analyzer",
    remediation: "Revoke the token in the Slack admin console and inject a replacement through an environment variable.",
  },
  {
    type: "hardcoded_generic_secret",
    id: "secrets.generic.assigned-literal",
    title: "Credential assigned a literal value",
    description: "A credential-shaped identifier (apiKey, access_token, client_secret, …) is assigned a quoted literal that does not look like a placeholder.",
    category: "secrets", severity: "high", confidence: "medium",
    cwe: ["CWE-798"], owasp: ["A07:2021-Identification and Authentication Failures"],
    languages: ["*"], module: "secrets-analyzer",
    remediation: "Move the value to an environment variable or secret store and rotate it. If it was never a real credential, a placeholder the scanner recognises (process.env.X, YOUR_KEY_HERE) keeps this quiet without a suppression.",
  },
  {
    type: "private_key_material",
    id: "secrets.private-key.pem",
    title: "Private key committed to source",
    description: "A PEM private-key banner appears in tracked source.",
    category: "secrets", severity: "critical", confidence: "high",
    cwe: ["CWE-798", "CWE-321"], owasp: ["A02:2021-Cryptographic Failures"],
    languages: ["*"], module: "secrets-analyzer",
    remediation: "Rotate the key pair and remove the material from source control. Anything it signed or decrypted must be treated as exposed.",
  },
  {
    type: "hardcoded_credential_assignment",
    id: "secrets.credential.ast-assignment",
    title: "Credential assigned a literal (AST-confirmed)",
    description: "An assignment or object property whose name is credential-shaped receives a string literal. Confirmed structurally rather than by line matching, so a multi-line or reformatted assignment is still caught.",
    category: "secrets", severity: "high", confidence: "medium",
    cwe: ["CWE-798"], owasp: ["A07:2021-Identification and Authentication Failures"],
    languages: ["javascript"], module: "ast-analyzer",
    remediation: "Read the value from configuration at runtime and rotate the committed one.",
  },
  {
    type: "hardcoded_db_connection_string",
    id: "secrets.database.connection-string",
    title: "Database connection string with inline credentials",
    description: "A database URI carries a username and password inline.",
    category: "secrets", severity: "critical", confidence: "high",
    cwe: ["CWE-798"], owasp: ["A07:2021-Identification and Authentication Failures"],
    languages: ["*"], module: "secrets-analyzer",
    remediation: "Rotate the database password and assemble the connection string from environment variables at runtime.",
  },

  // ------------------------------------------------------------ injection
  {
    type: "sql_string_concatenation",
    id: "sast.sql-injection.string-concat",
    title: "SQL query built by string concatenation",
    description: "A string literal containing SQL keywords is concatenated with a variable.",
    category: "injection", severity: "high", confidence: "medium", group: "sql-injection",
    cwe: ["CWE-89"], owasp: ["A03:2021-Injection"],
    languages: ["javascript", "typescript", "python", "ruby", "php", "java"], module: "pattern-analyzer",
    remediation: "Use parameterized queries — `?` placeholders or `$1` bind parameters. The database driver escapes bound values; string concatenation cannot.",
  },
  {
    type: "sql_template_literal_injection",
    id: "sast.sql-injection.template-literal",
    title: "SQL query built by template interpolation",
    description: "A template literal contains both SQL keywords and a `${…}` interpolation.",
    category: "injection", severity: "high", confidence: "medium", group: "sql-injection",
    cwe: ["CWE-89"], owasp: ["A03:2021-Injection"],
    languages: ["javascript", "typescript"], module: "pattern-analyzer",
    remediation: "Use the driver's placeholder syntax instead of interpolation. Tagged templates from a library that parameterizes (`sql\\`…\\``) are safe; a bare template literal is not.",
  },
  {
    type: "sql_injection_tainted",
    id: "sast.sql-injection.tainted-query",
    title: "Request data reaches a SQL query",
    description: "A value originating in the HTTP request flows into a query call without an intervening parameterization boundary.",
    category: "injection", severity: "critical", confidence: "high", group: "sql-injection",
    cwe: ["CWE-89"], owasp: ["A03:2021-Injection"],
    languages: ["javascript"], module: "ast-analyzer",
    remediation: "Pass the value as a bind parameter rather than building the query text with it.",
  },
  {
    type: "nosql_injection",
    id: "sast.nosql-injection.operator-injection",
    title: "Request data used directly as a MongoDB query object",
    description: "A request-derived value is passed as a query document. An attacker who controls the shape can inject operators such as `$ne` or `$gt` to bypass the filter entirely.",
    category: "injection", severity: "high", confidence: "medium",
    cwe: ["CWE-943"], owasp: ["A03:2021-Injection"],
    languages: ["javascript", "typescript"], module: "pattern-analyzer",
    remediation: "Coerce request values to their expected primitive type before querying (`String(req.body.user)`), or validate against a schema. Never spread a request body into a query document.",
  },
  {
    type: "command_injection",
    id: "sast.command-injection.shell-string",
    title: "Shell command built from a variable",
    description: "A shell-executing call receives a command assembled by interpolation or concatenation.",
    category: "injection", severity: "critical", confidence: "medium", group: "command-injection",
    cwe: ["CWE-78"], owasp: ["A03:2021-Injection"],
    languages: ["javascript", "typescript", "python", "ruby"], module: "pattern-analyzer",
    remediation: "Pass an argument array instead of a shell string: `execFile(cmd, [args])`, `subprocess.run([...], shell=False)`. With no shell there is no metacharacter to inject.",
  },
  {
    type: "command_injection_tainted",
    id: "sast.command-injection.tainted-exec",
    title: "Request data reaches a shell execution",
    description: "A value originating in the HTTP request flows into a shell-executing call.",
    category: "injection", severity: "critical", confidence: "high", group: "command-injection",
    cwe: ["CWE-78"], owasp: ["A03:2021-Injection"],
    languages: ["javascript"], module: "ast-analyzer",
    remediation: "Use the argument-array form of the call, and validate the value against an allowlist before it reaches the process boundary.",
  },
  {
    type: "use_of_eval",
    id: "sast.code-injection.eval",
    title: "Dynamic code evaluation",
    description: "`eval` or `new Function` compiles a string as code at runtime.",
    category: "injection", severity: "high", confidence: "medium", group: "code-injection",
    cwe: ["CWE-95"], owasp: ["A03:2021-Injection"],
    languages: ["javascript", "typescript", "python"], module: "pattern-analyzer",
    remediation: "Replace with an explicit dispatch table, or `JSON.parse` when the input is data. If code really must be evaluated, run it in a sandboxed isolate with no ambient authority.",
  },
  {
    type: "code_injection_tainted",
    id: "sast.code-injection.tainted-eval",
    title: "Request data reaches dynamic code evaluation",
    description: "A value originating in the HTTP request flows into `eval` or `new Function` — arbitrary remote code execution.",
    category: "injection", severity: "critical", confidence: "high", group: "code-injection",
    cwe: ["CWE-95"], owasp: ["A03:2021-Injection"],
    languages: ["javascript"], module: "ast-analyzer",
    remediation: "Remove the dynamic evaluation. There is no input validation that makes `eval` on request data safe.",
  },
  {
    type: "use_of_exec",
    id: "sast.command-injection.exec-call",
    title: "Process execution call",
    description: "A call that spawns a process through a shell.",
    category: "injection", severity: "high", confidence: "low", group: "command-injection",
    cwe: ["CWE-78"], owasp: ["A03:2021-Injection"],
    languages: ["javascript", "typescript", "python"], module: "pattern-analyzer",
    remediation: "Confirm the command string is not attacker-influenced; prefer the argument-array form regardless.",
  },
  {
    type: "template_injection",
    id: "sast.template-injection.dynamic-template",
    title: "Template compiled from a variable",
    description: "A template engine compiles a string assembled at runtime, letting an attacker who controls it execute template expressions in the server context.",
    category: "injection", severity: "high", confidence: "medium",
    cwe: ["CWE-1336"], owasp: ["A03:2021-Injection"],
    languages: ["javascript", "typescript", "python"], module: "pattern-analyzer",
    remediation: "Compile templates from static files and pass user data as template VARIABLES, never as template SOURCE.",
  },
  {
    type: "xxe_external_entities",
    id: "sast.xxe.external-entities-enabled",
    title: "XML parser configured to resolve external entities",
    description: "An XML parser is explicitly configured to load external entities or DTDs, which lets a crafted document read local files or make outbound requests.",
    category: "injection", severity: "high", confidence: "high",
    cwe: ["CWE-611"], owasp: ["A05:2021-Security Misconfiguration"],
    languages: ["javascript", "typescript", "python", "java", "php"], module: "pattern-analyzer",
    remediation: "Leave external-entity and DTD resolution disabled — the secure default in every modern parser. There is no common use case that needs them on.",
  },

  // ------------------------------------------------------------------ xss
  {
    type: "xss_sink",
    id: "sast.xss.html-sink",
    title: "Unsanitized value assigned to an HTML sink",
    description: "A non-literal value is written to `innerHTML`, `document.write`, or React's `dangerouslySetInnerHTML`.",
    category: "xss", severity: "high", confidence: "medium", group: "xss-sink",
    cwe: ["CWE-79"], owasp: ["A03:2021-Injection"],
    languages: ["javascript", "typescript", "html"], module: "pattern-analyzer",
    remediation: "Use `textContent` for text. When HTML is genuinely required, sanitize with a vetted library (DOMPurify) immediately before insertion.",
  },
  {
    type: "xss_tainted_sink",
    id: "sast.xss.tainted-html-sink",
    title: "Request data reaches an HTML sink",
    description: "A value originating in the HTTP request is written into the DOM as markup.",
    category: "xss", severity: "high", confidence: "high", group: "xss-sink",
    cwe: ["CWE-79"], owasp: ["A03:2021-Injection"],
    languages: ["javascript"], module: "ast-analyzer",
    remediation: "Render the value as text, or sanitize it. Escaping at the sink is the only reliable place — escaping at input misses every other path to the same sink.",
  },
  {
    type: "response_send_tainted_html",
    id: "sast.xss.reflected-response",
    title: "Request data reflected into an HTML response",
    description: "A value from the request is concatenated into an HTML response body without encoding — reflected XSS.",
    category: "xss", severity: "high", confidence: "medium",
    cwe: ["CWE-79"], owasp: ["A03:2021-Injection"],
    languages: ["javascript", "typescript"], module: "pattern-analyzer",
    remediation: "Render through a template engine with contextual auto-escaping, or HTML-encode the value before it reaches the response.",
  },

  // ------------------------------------------------------------- traversal
  {
    type: "path_traversal",
    id: "sast.path-traversal.unvalidated-join",
    title: "File path built from a request value",
    description: "A filesystem call receives a path assembled from request data, so `../` sequences escape the intended directory.",
    category: "traversal", severity: "high", confidence: "medium", group: "path-traversal",
    cwe: ["CWE-22"], owasp: ["A01:2021-Broken Access Control"],
    languages: ["javascript", "typescript", "python"], module: "pattern-analyzer",
    remediation: "Resolve the joined path and verify it still sits inside the intended root (`path.resolve(base, p).startsWith(base + path.sep)`), or index user input against an allowlist rather than using it as a path.",
  },
  {
    type: "path_traversal_tainted",
    id: "sast.path-traversal.tainted-fs-call",
    title: "Request data reaches a filesystem call",
    description: "A value originating in the HTTP request flows into a file read, write, or send.",
    category: "traversal", severity: "high", confidence: "high", group: "path-traversal",
    cwe: ["CWE-22"], owasp: ["A01:2021-Broken Access Control"],
    languages: ["javascript"], module: "ast-analyzer",
    remediation: "Containment-check the resolved path against its root before opening it.",
  },

  // ------------------------------------------------------------------ ssrf
  {
    type: "ssrf_tainted_fetch",
    id: "sast.ssrf.tainted-url",
    title: "Request data reaches an outbound HTTP call",
    description: "A URL derived from the HTTP request is fetched server-side, letting an attacker reach internal services and cloud metadata endpoints the server can see and they cannot.",
    category: "ssrf", severity: "high", confidence: "high", group: "ssrf",
    cwe: ["CWE-918"], owasp: ["A10:2021-Server-Side Request Forgery"],
    languages: ["javascript"], module: "ast-analyzer",
    remediation: "Allowlist the destination host. Blocklists do not work here — DNS rebinding, redirects and IPv6-mapped addresses all defeat them.",
  },
  {
    type: "ssrf_user_url",
    id: "sast.ssrf.user-supplied-url",
    title: "Outbound request to a user-supplied URL",
    description: "An HTTP client is called with a URL that came from the request.",
    category: "ssrf", severity: "high", confidence: "medium", group: "ssrf",
    cwe: ["CWE-918"], owasp: ["A10:2021-Server-Side Request Forgery"],
    languages: ["javascript", "typescript", "python"], module: "pattern-analyzer",
    remediation: "Resolve and allowlist the host before the request, and disable automatic redirect following so a permitted host cannot bounce you to a forbidden one.",
  },

  // -------------------------------------------------------------- redirect
  {
    type: "open_redirect",
    id: "sast.open-redirect.unvalidated-target",
    title: "Redirect to a request-controlled destination",
    description: "A redirect target comes from the request, so the application will send users to any site an attacker names — the credibility half of a phishing campaign.",
    category: "redirect", severity: "medium", confidence: "medium",
    cwe: ["CWE-601"], owasp: ["A01:2021-Broken Access Control"],
    languages: ["javascript", "typescript", "python"], module: "pattern-analyzer",
    remediation: "Redirect to a path only (reject anything with a scheme or `//`), or map an opaque key to a destination held server-side.",
  },

  // ------------------------------------------------------- deserialization
  {
    type: "insecure_deserialization",
    id: "sast.deserialization.unsafe-loader",
    title: "Unsafe deserialization",
    description: "A deserializer that can instantiate arbitrary types is applied to data — `pickle.loads`, `yaml.load` without a safe loader, PHP `unserialize`, Ruby `Marshal.load`.",
    category: "deserialization", severity: "high", confidence: "medium",
    cwe: ["CWE-502"], owasp: ["A08:2021-Software and Data Integrity Failures"],
    languages: ["python", "ruby", "php", "java", "javascript"], module: "pattern-analyzer",
    remediation: "Use a data-only format. `yaml.safe_load` instead of `yaml.load`, JSON instead of pickle. Never deserialize a format that can construct objects from data that crossed a trust boundary.",
  },

  // ---------------------------------------------------------------- crypto
  {
    type: "weak_hash_algorithm",
    id: "sast.crypto.weak-hash",
    title: "Broken hash algorithm",
    description: "MD5 or SHA-1 is used through a cryptographic hashing API.",
    category: "crypto", severity: "medium", confidence: "medium",
    cwe: ["CWE-327", "CWE-328"], owasp: ["A02:2021-Cryptographic Failures"],
    languages: ["javascript", "typescript", "python", "java", "php"], module: "pattern-analyzer",
    remediation: "SHA-256 or better for integrity. For passwords, a raw digest is wrong at any strength — use bcrypt, scrypt or Argon2.",
  },
  {
    type: "weak_password_hash",
    id: "sast.crypto.password-fast-hash",
    title: "Password hashed with a fast digest",
    description: "A password value is passed to a general-purpose hash. Fast digests are designed for speed, which is exactly what an offline cracker wants.",
    category: "crypto", severity: "high", confidence: "medium",
    cwe: ["CWE-916"], owasp: ["A02:2021-Cryptographic Failures"],
    languages: ["javascript", "typescript", "python"], module: "pattern-analyzer",
    remediation: "Use a memory-hard password hash with a per-password salt — bcrypt, scrypt, or Argon2id — through a maintained library.",
  },
  {
    type: "weak_cipher_algorithm",
    id: "sast.crypto.weak-cipher",
    title: "Broken or ECB-mode cipher",
    description: "DES, RC4, or a block cipher in ECB mode. ECB leaks plaintext structure because identical blocks encrypt identically.",
    category: "crypto", severity: "high", confidence: "high",
    cwe: ["CWE-327"], owasp: ["A02:2021-Cryptographic Failures"],
    languages: ["javascript", "typescript", "python", "java"], module: "pattern-analyzer",
    remediation: "Use an authenticated mode — AES-256-GCM or ChaCha20-Poly1305 — with a unique nonce per message.",
  },
  {
    type: "insecure_randomness",
    id: "sast.crypto.insecure-random",
    title: "Predictable randomness for a security value",
    description: "A non-cryptographic PRNG generates a value whose name marks it as security-relevant (token, nonce, salt, session, OTP).",
    category: "crypto", severity: "medium", confidence: "medium",
    cwe: ["CWE-338"], owasp: ["A02:2021-Cryptographic Failures"],
    languages: ["javascript", "typescript", "python"], module: "pattern-analyzer",
    remediation: "`crypto.getRandomValues` / `crypto.randomUUID` in JavaScript, the `secrets` module in Python.",
  },
  {
    type: "disabled_tls_verification",
    id: "sast.crypto.tls-verification-disabled",
    title: "TLS certificate verification disabled",
    description: "Certificate verification is explicitly switched off, which reduces TLS to obfuscation against anyone on the network path.",
    category: "crypto", severity: "high", confidence: "high",
    cwe: ["CWE-295"], owasp: ["A02:2021-Cryptographic Failures"],
    languages: ["javascript", "typescript", "python", "go", "php"], module: "pattern-analyzer",
    remediation: "Leave verification on. If a private CA is the problem, add that CA to the trust store rather than trusting everything.",
  },
  {
    type: "insecure_http_url",
    id: "sast.transport.cleartext-url",
    title: "Cleartext http:// endpoint",
    description: "A non-local `http://` URL appears in source or configuration.",
    category: "data-exposure", severity: "low", confidence: "medium",
    cwe: ["CWE-319"], owasp: ["A02:2021-Cryptographic Failures"],
    languages: ["*"], module: "pattern-analyzer",
    remediation: "Use https:// for anything that leaves the machine — http:// sends cookies, tokens and credentials in the clear.",
  },

  // --------------------------------------------------------- data exposure
  {
    type: "sensitive_data_logging",
    id: "sast.logging.sensitive-value",
    title: "Credential or token written to a log",
    description: "A logging call receives a value whose name marks it as a secret. Logs are aggregated, retained, and read by far more people than the credential store is.",
    category: "data-exposure", severity: "medium", confidence: "medium",
    cwe: ["CWE-532"], owasp: ["A09:2021-Security Logging and Monitoring Failures"],
    languages: ["javascript", "typescript", "python", "ruby"], module: "pattern-analyzer",
    remediation: "Log an identifier, never the value. If the shape matters for debugging, log its length or a truncated hash.",
  },

  // ------------------------------------------------------------------ auth
  {
    type: "jwt_none_algorithm",
    id: "sast.auth.jwt-verification-bypass",
    title: "JWT signature verification disabled",
    description: "A JWT is decoded without verification, or `none` is an accepted algorithm — either way the signature stops being a security control and the token becomes attacker-writable.",
    category: "auth", severity: "critical", confidence: "high",
    cwe: ["CWE-347"], owasp: ["A02:2021-Cryptographic Failures"],
    languages: ["javascript", "typescript", "python"], module: "pattern-analyzer",
    remediation: "Always `verify` with an explicit algorithm allowlist. `decode` is for reading a token you have already verified.",
  },
  {
    type: "insecure_cookie_flags",
    id: "sast.auth.cookie-missing-flags",
    title: "Session cookie set without protective flags",
    description: "A cookie carrying session or authentication state is configured with `httpOnly` or `secure` explicitly false.",
    category: "auth", severity: "medium", confidence: "high",
    cwe: ["CWE-1004", "CWE-614"], owasp: ["A05:2021-Security Misconfiguration"],
    languages: ["javascript", "typescript"], module: "pattern-analyzer",
    remediation: "Set `httpOnly: true`, `secure: true` and an explicit `sameSite` on every session cookie.",
  },
  {
    type: "missing_auth_guard",
    id: "sast.auth.route-without-guard",
    title: "State-changing route with no visible authentication guard",
    description: "A POST/PUT/PATCH/DELETE route declares no middleware and its handler contains no recognisable authentication or authorization check.",
    category: "auth", severity: "medium", confidence: "low",
    cwe: ["CWE-306"], owasp: ["A01:2021-Broken Access Control"],
    languages: ["javascript"], module: "ast-analyzer",
    remediation: "Attach the router's auth middleware, or check the session inside the handler. If the route is deliberately public, an explicit comment or a name that says so keeps this quiet.",
  },

  // -------------------------------------------------------- access control
  {
    type: "missing_ownership_check",
    id: "sast.access-control.idor",
    title: "Record looked up by a request-supplied id with no ownership check",
    description: "A database lookup is keyed on an id taken from the request, and the surrounding handler compares nothing against the session's identity — the classic IDOR shape, where changing a number in the URL returns someone else's record.",
    category: "access-control", severity: "high", confidence: "low",
    cwe: ["CWE-639"], owasp: ["A01:2021-Broken Access Control"],
    languages: ["javascript"], module: "ast-analyzer",
    remediation: "Scope the query by the authenticated principal (`WHERE id = ? AND owner_id = ?`) rather than fetching first and checking after — or verify ownership before returning.",
  },
  {
    type: "missing_tenant_scope",
    id: "sast.access-control.tenant-scope-missing",
    title: "Multi-tenant query without a tenant filter",
    description: "A SQL statement against a table carrying a tenant column omits that column from its WHERE clause, in a file where sibling queries include it.",
    category: "access-control", severity: "high", confidence: "low",
    cwe: ["CWE-639"], owasp: ["A01:2021-Broken Access Control"],
    languages: ["javascript", "typescript"], module: "pattern-analyzer",
    remediation: "Filter every tenant-scoped read by the tenant id. One missing filter is a cross-tenant data leak, and it is invisible until someone reports another customer's data.",
  },

  // --------------------------------------------------------- configuration
  {
    type: "permissive_cors",
    id: "sast.cors.wildcard-with-credentials",
    title: "Wildcard CORS origin combined with credentials",
    description: "An allow-any-origin CORS policy is paired with credentialed requests, letting any site read authenticated responses on behalf of a logged-in visitor.",
    category: "configuration", severity: "high", confidence: "high",
    cwe: ["CWE-942"], owasp: ["A05:2021-Security Misconfiguration"],
    languages: ["javascript", "typescript", "python"], module: "pattern-analyzer",
    remediation: "Reflect only origins from an allowlist when credentials are enabled. Browsers reject `*` with credentials — code that works around that rejection is defeating the protection deliberately.",
  },
  {
    type: "cors_reflects_origin",
    id: "sast.cors.origin-reflection",
    title: "CORS policy reflects the request origin",
    description: "The Access-Control-Allow-Origin header is set from the request's own Origin header, which allowlists every site that asks.",
    category: "configuration", severity: "high", confidence: "medium",
    cwe: ["CWE-942"], owasp: ["A05:2021-Security Misconfiguration"],
    languages: ["javascript", "typescript"], module: "pattern-analyzer",
    remediation: "Compare the origin against an allowlist and echo it only on a match.",
  },
  {
    type: "security_middleware_disabled",
    id: "sast.config.security-middleware-disabled",
    title: "Security middleware explicitly disabled",
    description: "CSRF protection, Helmet, or an equivalent protective middleware is switched off in source.",
    category: "configuration", severity: "high", confidence: "high",
    cwe: ["CWE-1173"], owasp: ["A05:2021-Security Misconfiguration"],
    languages: ["javascript", "typescript", "python"], module: "pattern-analyzer",
    remediation: "Re-enable it. If one endpoint genuinely cannot use it (a webhook verifying its own signature, say), exempt that route rather than disabling the middleware globally.",
  },
  {
    type: "debug_mode_enabled",
    id: "sast.config.debug-enabled",
    title: "Debug mode enabled in committed configuration",
    description: "A framework debug flag is set true in source. Debug handlers expose stack traces, environment variables, and in some frameworks an interactive console.",
    category: "configuration", severity: "medium", confidence: "medium",
    cwe: ["CWE-489"], owasp: ["A05:2021-Security Misconfiguration"],
    languages: ["python", "javascript", "typescript", "yaml"], module: "pattern-analyzer",
    remediation: "Drive it from the environment and default it off.",
  },
  {
    type: "unrestricted_file_upload",
    id: "sast.upload.no-type-or-size-limit",
    title: "File upload accepted with no type or size limit",
    description: "An upload middleware is configured with neither a size limit nor a file-type filter, allowing arbitrary content of arbitrary size.",
    category: "configuration", severity: "medium", confidence: "medium",
    cwe: ["CWE-434"], owasp: ["A04:2021-Insecure Design"],
    languages: ["javascript", "typescript"], module: "pattern-analyzer",
    remediation: "Set `limits.fileSize` and a `fileFilter` allowlisting content types. Store uploads outside the web root and never trust the client-supplied filename.",
  },

  // --------------------------------------------------------- supply chain
  {
    type: "remote_code_execution_install",
    id: "sast.supply-chain.curl-pipe-shell",
    title: "Remote script piped into a shell",
    description: "A script is downloaded and executed in one step, so whatever the URL serves at that moment runs with the build's privileges.",
    category: "supply-chain", severity: "high", confidence: "high",
    cwe: ["CWE-494"], owasp: ["A08:2021-Software and Data Integrity Failures"],
    languages: ["shell", "dockerfile", "yaml"], module: "pattern-analyzer",
    remediation: "Download to a file, verify a pinned checksum or signature, then execute.",
  },
  {
    type: "dockerfile_remote_add",
    id: "sast.supply-chain.dockerfile-remote-add",
    title: "Dockerfile ADD from a remote URL",
    description: "`ADD` with a URL fetches over the network at build time with no integrity check, and also auto-extracts archives.",
    category: "supply-chain", severity: "medium", confidence: "high",
    cwe: ["CWE-494"], owasp: ["A08:2021-Software and Data Integrity Failures"],
    languages: ["dockerfile"], module: "pattern-analyzer",
    remediation: "Use `RUN curl -fsSL <url> -o file && echo '<sha256>  file' | sha256sum -c` so the build fails when the payload changes.",
  },
  {
    type: "vulnerable_dependency",
    id: "deps.known-vulnerability",
    title: "Dependency with a known advisory",
    description: "An installed package version matches a published OSV advisory.",
    category: "dependency", severity: "high", confidence: "high",
    cwe: [], owasp: ["A06:2021-Vulnerable and Outdated Components"],
    languages: ["*"], module: "dependency-analyzer",
    remediation: "Upgrade to the fixed version named in the advisory.",
  },
]);

let _byType = null;

/** type -> rule. Built once; the array is frozen, so caching is safe. */
export function rulesForTypes() {
  if (_byType) return _byType;
  _byType = new Map();
  for (const r of RULES) _byType.set(r.type, r);
  return _byType;
}

export function ruleById(id) {
  return RULES.find((r) => r.id === id) || null;
}

/** Every distinct CWE the ruleset covers, for the docs table and UI filters. */
export function coveredCwes() {
  const set = new Set();
  for (const r of RULES) for (const c of r.cwe) set.add(c);
  return [...set].sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
}

/** Every distinct OWASP Top 10 category the ruleset covers. */
export function coveredOwasp() {
  const set = new Set();
  for (const r of RULES) for (const o of r.owasp) set.add(o);
  return [...set].sort();
}
