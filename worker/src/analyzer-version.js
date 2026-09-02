// The deployed build that produced an analyzer result.
//
// Why this exists: the CI gate posts a repository's files to the DEPLOYED
// Worker, not to the code in the pull request. That is right for a normal
// change and a trap for a change to an analyzer — on #101 the gate reported
// nine findings the reviewer's own diff had already fixed, and nothing on the
// page said which build had answered.
//
// The first version of this read RELEASE_TAG. Nothing sets it, so every CI
// comment since read "Analyzer build: unreleased" — a field that always says
// the same thing, which is worse than no field because it looks like an
// answer. The version metadata binding replaces the guess with a fact
// Cloudflare already knows.

/** How much of a version id to show. Long enough to be unambiguous, short
 *  enough to sit in a PR comment — the same call the runs feed makes when it
 *  prints a 7-character commit sha. The full id is in `wrangler versions
 *  list`, and this is a prefix of it, so it stays greppable. */
const VERSION_ID_CHARS = 8;

/**
 * @param {object} env — Worker env.
 * @returns {string} a version identifier, or "unreleased" when there is
 *   genuinely nothing to report. Never an empty string: a blank in a
 *   provenance field reads as a rendering bug rather than as an absence.
 */
export function analyzerVersion(env) {
  // 1. The binding. Present on any deploy since [version_metadata] was added
  //    to wrangler.toml, whoever ran the deploy and however — no build step,
  //    no secret, nothing for a deploy path to forget.
  const meta = env && env.CF_VERSION_METADATA;
  if (meta && typeof meta === "object") {
    // A tag is set by hand and is meaningful when it exists, so it wins; the
    // id is always there and is what `wrangler versions list` prints.
    if (typeof meta.tag === "string" && meta.tag.trim()) return meta.tag.trim();
    if (typeof meta.id === "string" && meta.id.trim()) {
      return meta.id.trim().slice(0, VERSION_ID_CHARS);
    }
  }

  // 2. The env vars, kept for the staging deploy that already sets one and
  //    for any runtime where the binding is unavailable.
  const tag = env && (env.RELEASE_TAG || env.RELEASE);
  if (typeof tag === "string" && tag.trim()) return tag.trim();

  // 3. Nothing to report. Said in a word rather than left blank.
  return "unreleased";
}
