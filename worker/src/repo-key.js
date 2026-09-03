// One spelling of "which repository is this".
//
// Extracted from compliance/evidence.js, where it decided whether a stored run
// counted as evidence about the audited repo. It now has a second caller — the
// accepted-risk register, which must scope an acceptance to one repository —
// and two callers deriving the same key by different rules would mean an
// acceptance silently covering the wrong repo, or none.
//
// `owner/name`, lowercased. Enough to match a clone URL against a bare slug,
// which is what the two sides actually hold: a monitor stores
// https://github.com/Owner/Name, CI sends `owner/name` from GITHUB_REPOSITORY.

/** `owner/name`, lowercased. Empty string when nothing repo-shaped is present. */
export function normaliseRepo(raw) {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const m = trimmed.match(/github\.com[/:]([\w.-]+)\/([\w.-]+)$/i);
  if (m) return `${m[1]}/${m[2]}`.toLowerCase();
  const bare = trimmed.match(/^([\w.-]+)\/([\w.-]+)$/);
  return bare ? `${bare[1]}/${bare[2]}`.toLowerCase() : trimmed.toLowerCase();
}

/**
 * The key an acceptance is stored under, or null when there is no repository.
 *
 * Null is load-bearing: a scan of pasted content belongs to no repository, so
 * no acceptance can apply to it and every finding stays open. Same reasoning
 * as `matchesRepo` in compliance/evidence.js — a run carrying no repository
 * cannot be evidence about one.
 */
export function repoKeyFor(raw) {
  const key = normaliseRepo(raw);
  return /^[\w.-]+\/[\w.-]+$/.test(key) ? key : null;
}
