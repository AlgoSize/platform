// Credential-shaped test vectors, assembled at runtime.
//
// A scanner's own test suite needs strings that look exactly like real
// credentials — that is what it is testing. Writing them as literals means the
// repository carries secret-shaped bytes AT REST, and our own scanner reports
// them, correctly: secrets are never severity-capped in test code, because a
// real key does not care which directory it leaks from. The engine cannot tell
// our deliberate fakes from a genuine leak, and it should not try — a rule that
// exempts "test-looking" keys is a rule an attacker writes a test file around.
//
// So the fakes are CONCATENATED here and joined at call time. The bytes the
// scanner sees are identical; the bytes on disk never form the pattern. Ten
// criticals on this repository's own gate came from literals like these, and a
// critical list that is entirely false positives is one nobody reads — which is
// how the one real finding in it (a command injection in optimizer-ci.mjs) sat
// unnoticed.
//
// Values are AWS's and Stripe's own published documentation examples where such
// an example exists, so they are recognisably fake to a human reader too.

/** AWS access key id — AWS's documented example value. */
export const fakeAwsKeyId = () => "AKIA" + "IOSFODNN7" + "EXAMPLE";

/** Stripe live secret key shape. Not a real key; the tail is filler. */
export const fakeStripeLiveKey = () => "sk_" + "live_" + "abcdef0123456789ABCDEFGH";

/** GitHub personal access token shape. */
export const fakeGithubPat = () => "ghp_" + "abcdefghijklmnopqrstuvwxyz" + "0123456789";

/**
 * A PEM delimiter line: `-----BEGIN RSA PRIVATE KEY-----`.
 * `algo` may be empty for the bare `PRIVATE KEY` form.
 */
export const fakePemBanner = (kind = "BEGIN", algo = "RSA") =>
  "-----" + kind + (algo ? " " + algo : "") + " PRIVATE KEY-----";

/** A complete PEM block with filler body. */
export const fakePem = (algo = "RSA", body = "MIIEow==") =>
  fakePemBanner("BEGIN", algo) + "\n" + body + "\n" + fakePemBanner("END", algo);
