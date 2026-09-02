// The deployed build that produced an analyzer result.
//
// RELEASE_TAG is set by release automation when available; RELEASE is kept as
// the existing compatibility name used by observability. An absent tag is
// explicit rather than an empty provenance claim.
export function analyzerVersion(env) {
  return (env && (env.RELEASE_TAG || env.RELEASE)) || "unreleased";
}