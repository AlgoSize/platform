// Custom report domains — validation, and the DNS check behind the badge.
//
// A Firm customer can serve shared reports from a host they own
// (reports.theirfirm.com) instead of algosize.com/r/…. This module owns two
// questions: is that string a hostname we will accept, and does it currently
// point at us.
//
// ---------------------------------------------------------------------------
// What this module does NOT do
// ---------------------------------------------------------------------------
// It does not make the hostname serve anything. Terminating TLS for a domain
// somebody else owns is Cloudflare for SaaS (custom hostnames), which needs
// zone-level credentials this Worker deliberately does not carry. So the
// verification state machine is complete and honest here — the record is
// checked for real, against real DNS — and the serving half is a separate,
// operator-run step.
//
// That split is stated in the API response (`servingReady: false`) rather
// than hidden, because the failure it prevents is the expensive one: telling
// a consultancy their domain is "verified", watching them put it in front of
// a client, and having the client get a TLS error.
//
// ---------------------------------------------------------------------------
// Why DNS-over-HTTPS
// ---------------------------------------------------------------------------
// Workers have no DNS resolver — there is no `dns.resolveCname`. The only way
// to ask a DNS question is to ask over HTTP, so we query Cloudflare's public
// resolver at 1.1.1.1 with `Accept: application/dns-json`. No credential is
// involved: this is the same public resolver anyone can query, and we are
// asking about a record the customer published deliberately.

/** Where a customer points their CNAME. Overridable per environment. */
export function cnameTarget(env) {
  return (env && env.REPORT_CNAME_TARGET) || "cname.algosize.com";
}

const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";

/** Longest a hostname may be, per RFC 1035. */
const MAX_HOSTNAME = 253;

// A hostname we will accept: at least two labels, each 1–63 chars of
// alphanumerics and hyphens, not starting or ending with a hyphen, and a TLD
// that is alphabetic. Deliberately stricter than DNS allows — we are not
// trying to accept every legal name, only the ones a customer would actually
// put in front of a client.
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOSTNAME_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})*\\.[a-z]{2,}$`);

/**
 * Normalise and validate a domain a customer typed.
 *
 * Accepts what people actually paste — a full URL, a trailing slash, mixed
 * case, stray whitespace — and returns the bare lowercase hostname, or null.
 *
 * Refuses `algosize.com` and its subdomains. Someone entering our own domain
 * is either confused or trying something, and either way the result would be
 * a verification that "succeeds" and a routing conflict with the real site.
 */
export function safeDomain(raw) {
  if (typeof raw !== "string") return null;
  let s = raw.trim().toLowerCase();
  if (!s) return null;

  // Tolerate a pasted URL.
  if (s.includes("://")) {
    try { s = new URL(s).hostname; } catch { return null; }
  }
  s = s.replace(/\/.*$/, "").replace(/\.$/, "");
  // A port makes no sense for a CNAME target and is a sign of a pasted
  // dev URL; refuse rather than silently dropping it.
  if (s.includes(":")) return null;
  if (!s || s.length > MAX_HOSTNAME) return null;
  if (!HOSTNAME_RE.test(s)) return null;

  if (s === "algosize.com" || s.endsWith(".algosize.com")) return null;
  return s;
}

/** The record the UI tells the customer to create. */
export function dnsRecordFor(env, domain) {
  return { type: "CNAME", name: domain, value: cnameTarget(env) };
}

/**
 * Ask public DNS what `domain` is a CNAME for.
 *
 * Returns `{ ok, found, error }`. `found` is the target with any trailing dot
 * stripped, or null when the name resolves to something that is not a CNAME
 * (an A record, most commonly — someone pointing at an IP instead).
 *
 * `ok: false` means the LOOKUP failed, which is not the same as the record
 * being wrong, and the caller must not record a failure for it. A resolver
 * outage that quietly marked every customer domain as failed would be a
 * self-inflicted incident.
 */
export async function resolveCname(domain, { fetchImpl = fetch } = {}) {
  const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(domain)}&type=CNAME`;
  let res;
  try {
    res = await fetchImpl(url, { headers: { Accept: "application/dns-json" } });
  } catch (err) {
    return { ok: false, found: null, error: (err && err.message) || "network error" };
  }
  if (!res || !res.ok) {
    return { ok: false, found: null, error: `resolver returned ${res && res.status}` };
  }

  let body;
  try { body = await res.json(); } catch { return { ok: false, found: null, error: "bad resolver response" }; }

  // Status 3 is NXDOMAIN — the name does not exist. That IS an answer, and a
  // definite one: the customer has not created the record yet.
  if (body && body.Status === 3) return { ok: true, found: null, error: null };
  if (body && body.Status !== 0) return { ok: false, found: null, error: `DNS status ${body.Status}` };

  // Type 5 is CNAME. Anything else in the answer (an A record, say) means the
  // name exists but is not delegated to us, which we report as "found
  // something else" rather than "found nothing" — those need different fixes.
  const answers = (body && body.Answer) || [];
  const cname = answers.find((a) => a.type === 5);
  if (cname && typeof cname.data === "string") {
    return { ok: true, found: cname.data.replace(/\.$/, "").toLowerCase(), error: null };
  }
  if (answers.length) {
    const other = answers[0];
    return { ok: true, found: String(other.data || "").replace(/\.$/, "").toLowerCase(), error: null };
  }
  return { ok: true, found: null, error: null };
}

/** Attempts before a pending domain is called failed. */
export const MAX_VERIFY_ATTEMPTS = 12;

/**
 * One verification pass.
 *
 * Returns the new state: `{ status, detail, attempts, checkedAt }`.
 *
 *   'verified' the CNAME resolves to our target
 *   'pending'  no record yet, or the lookup itself failed, and there are
 *              attempts left
 *   'failed'   attempts exhausted
 *
 * `detail` carries the observed value on anything that is not verified —
 * "verification failed" with no observed value tells the customer nothing
 * about whether the record is missing or merely wrong, and those are
 * different fixes.
 *
 * A lookup that could not be performed (`ok: false`) never consumes an
 * attempt. Only a real, answered "no" counts against the budget.
 */
export async function verifyDomain(env, domain, { attempts = 0, fetchImpl = fetch } = {}) {
  const expected = cnameTarget(env);
  const checkedAt = Math.floor(Date.now() / 1000);
  const res = await resolveCname(domain, { fetchImpl });

  if (!res.ok) {
    return {
      status: "pending",
      detail: `Could not check DNS: ${res.error}. Not counted as an attempt.`,
      attempts,
      checkedAt,
    };
  }

  if (res.found === expected) {
    return { status: "verified", detail: null, attempts, checkedAt };
  }

  const next = attempts + 1;
  const detail = res.found
    ? `Found ${res.found}, expected ${expected}.`
    : `No CNAME record found for ${domain}. Expected ${expected}.`;

  return {
    status: next >= MAX_VERIFY_ATTEMPTS ? "failed" : "pending",
    detail,
    attempts: next,
    checkedAt,
  };
}
