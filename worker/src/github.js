// One place that talks to GitHub.
//
// ---------------------------------------------------------------------------
// WHY THIS MODULE EXISTS
// ---------------------------------------------------------------------------
// Three analyzers each listed the same git tree, at the same commit, in the
// same sweep: the dependency audit, the source scanner, and the architecture
// X-ray. Three identical requests, no cache, once an hour, per monitor.
//
// Unauthenticated the GitHub API allows 60 requests per hour PER IP, and a
// Cloudflare Worker's egress IP is shared far beyond one account. Three tree
// listings per monitor meant roughly twenty monitors an hour, deployment-wide,
// before the budget was gone — after which every sweep reported "GitHub
// rate-limited the request" and every scorecard cell downstream of it read
// NOT MEASURED. The dependency column kept working only because it is the
// cheapest path and won the race for the last of the budget.
//
// Two changes fix that, and both live here:
//
//   1. ONE LISTING PER SWEEP. `fetchRepoTree` memoises on a caller-supplied
//      cache, so the second and third analyzers reuse the first one's answer.
//      The cache is per sweep, never global: a tree cached across sweeps would
//      be a stale answer presented as a fresh measurement.
//   2. EVERY REQUEST AUTHENTICATED. `ghHeaders` is applied to the tree listing
//      AND to every raw content fetch. The token was already read for the tree
//      listings; the content fetches — which outnumber them roughly fifty to
//      one — were sent bare, so setting the token used to fix about a fifth of
//      the traffic. Raw content for a public repository does not require auth;
//      the point is that an authenticated request draws on the token's
//      5,000/hour budget rather than the shared 60/hour anonymous pool.
//
// GITHUB_TOKEN is optional. Unset, everything below behaves exactly as it did
// before — anonymous, and rate-limited accordingly. It is never logged.

/** Shared headers. The token, when set, is our own read credential for public
 *  content; it is never a customer's and never appears in output. */
export function ghHeaders(env, extra = null) {
  const headers = { "User-Agent": "algosize-monitor", ...(extra || {}) };
  if (env && env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  return headers;
}

/** A cache for one sweep of one repository. Create it per sweep, pass it to
 *  every analyzer in that sweep, then throw it away. */
export function newTreeCache() { return new Map(); }

/**
 * List a repository's git tree once.
 *
 * Returns one of:
 *   { entries, branch }                the tree, and which branch answered
 *   { throttled: true, status }        403 / 429 / 5xx — transient, ours to wait out
 *   { unauthorized: true }             401 — our token was rejected, ours to fix
 *   { unavailable: true }              404 on every candidate branch
 *
 * The 401 case is why this returns a shape rather than a bare array. It used
 * to fall through the same `!res.ok → continue` as a 404, so an expired token
 * made every repository on the platform look as though it did not exist —
 * a deployment problem wearing a customer's clothes.
 */
export async function fetchRepoTree({ owner, repo, branch }, fetchImpl, env, cache = null) {
  const branches = branch ? [branch] : ["main", "master"];
  const key = `${owner}/${repo}@${branches.join(",")}`;
  if (cache && cache.has(key)) return cache.get(key);

  const headers = ghHeaders(env, { Accept: "application/vnd.github+json" });
  let result = { unavailable: true };

  for (const b of branches) {
    const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(b)}?recursive=1`;
    let res;
    try { res = await fetchImpl(url, { headers }); } catch { continue; }

    if (res.status === 401) { result = { unauthorized: true }; break; }
    if (res.status === 429 || res.status === 403 || res.status >= 500) {
      // `status` rides along because 403/429 and 5xx are the same OUTCOME
      // (skip, leave the baseline alone) but not the same CAUSE, and one
      // caller acts on the difference: api.github.com being briefly broken is
      // no reason to stop trying raw.githubusercontent.com, which is a
      // separate service, whereas a quota exhaustion applies to both.
      result = { throttled: true, status: res.status };
      break;
    }
    if (!res.ok) continue;

    let body;
    try { body = await res.json(); } catch { continue; }
    const entries = Array.isArray(body && body.tree) ? body.tree : [];
    result = { entries, branch: b };
    break;
  }

  if (cache) cache.set(key, result);
  return result;
}

/**
 * Fetch one file's bytes from raw.githubusercontent.com.
 *
 * Returns `{ text }`, `{ throttled: true, status }`, or null when the file is
 * simply not there. Separated from the callers so the Authorization header
 * cannot be forgotten at one of the four sites that need it — which is exactly
 * how it came to be missing from all four.
 *
 * `status` rides along on the throttled shape because one caller distinguishes
 * "GitHub told us to slow down" (503, retry) from "GitHub is down" (502) in the
 * error it returns, and folding both into a bare boolean would have made those
 * two answers the same sentence.
 */
export async function fetchRawFile({ owner, repo, branch, path }, fetchImpl, env, maxBytes) {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${encodeURI(path)}`;
  let res;
  try { res = await fetchImpl(url, { headers: ghHeaders(env) }); } catch { return null; }
  if (res.status === 429 || res.status === 403 || res.status >= 500) {
    return { throttled: true, status: res.status };
  }
  if (!res.ok) return null;
  const text = await res.text();
  if (typeof maxBytes === "number" && text.length > maxBytes) return null;
  return { text };
}
