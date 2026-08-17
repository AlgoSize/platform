// Rendered reports in R2.
//
// The report is rendered once, when the audit completes, and served from R2
// afterwards. That matters for the share-link case in particular: a link handed
// to a client can be opened at any time, by someone with no account, and
// re-deriving the document on every one of those requests would mean the
// customer's client is exercising our render path — and paying its latency —
// long after the run itself is history.
//
// EVERY FUNCTION HERE DEGRADES TO A NO-OP WHEN THE BUCKET IS ABSENT. `REPORTS`
// is declared in wrangler.toml but the bucket has to be created in the account
// before a deploy can bind it, and the same posture the queues take applies
// here: the feature must not be the reason a deploy fails or a request 500s.
// With no bucket, reads miss and the caller renders on demand — slower, same
// bytes. See getRunReportHandler in handlers/runs.js.

/**
 * Where a run's HTML report lives.
 *
 * Keyed by org first so a bucket listing is naturally scoped to a customer —
 * which is what makes "delete everything belonging to this org" a prefix
 * delete rather than a scan. The org id is also the access-control boundary
 * everywhere else in the system, so a key that starts with it is one fewer
 * mapping to get wrong.
 */
export function reportKey(orgId, runId) {
  return `reports/${orgId || "unassigned"}/${runId}.html`;
}

/**
 * Store a rendered report. Returns the key on success, null when there is no
 * bucket bound or the write failed.
 *
 * Never throws: this runs inside ctx.waitUntil after the user already has
 * their answer, and a failed cache write must not surface as a failed audit.
 */
export async function putReport(env, { orgId, runId, html }) {
  if (!env || !env.REPORTS || !runId || !html) return null;
  const key = reportKey(orgId, runId);
  try {
    await env.REPORTS.put(key, html, {
      httpMetadata: {
        contentType: "text/html; charset=utf-8",
        // Immutable: a report describes one run at one instant. If the
        // branding changes, the NEXT report carries it — rewriting history so
        // a document someone already forwarded silently changes is worse.
        cacheControl: "private, max-age=31536000, immutable",
      },
    });
    return key;
  } catch (err) {
    console.error("reports: R2 put failed", { key, message: err && err.message });
    return null;
  }
}

/** Fetch a stored report, or null when absent, unbound, or unreadable. */
export async function getReport(env, { orgId, runId }) {
  if (!env || !env.REPORTS || !runId) return null;
  const key = reportKey(orgId, runId);
  try {
    const object = await env.REPORTS.get(key);
    if (!object) return null;
    return await object.text();
  } catch (err) {
    console.error("reports: R2 get failed", { key, message: err && err.message });
    return null;
  }
}

/** Remove a stored report. Used when a run's branding must stop applying. */
export async function deleteReport(env, { orgId, runId }) {
  if (!env || !env.REPORTS || !runId) return false;
  try {
    await env.REPORTS.delete(reportKey(orgId, runId));
    return true;
  } catch (err) {
    console.error("reports: R2 delete failed", { message: err && err.message });
    return false;
  }
}
