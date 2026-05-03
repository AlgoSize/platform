// GET /api/pageview — server-side noscript pageview forwarder (Task #26).
//
// The marketing site's `<noscript>` tag points an <img> at this endpoint
// so visitors with JavaScript disabled still get counted. We accept a
// GET (because that's all an <img> can do), do a fire-and-forget POST
// to Plausible's events API on the server side (where we can choose
// the verb), and return a 1×1 transparent GIF so the browser is happy.
//
// Why not let the browser hit Plausible directly? Plausible's events
// API is POST-only — a plain `<img src="https://plausible.io/api/event...">`
// 404s. Routing through the Worker turns the unsupported GET into a
// supported POST without exposing Plausible's HTTP contract to the
// page (and keeps everything same-origin so trackers/blockers that
// already allow algosize.com continue to work).
//
// Privacy:
//   - Visitor IP is forwarded as `X-Forwarded-For` so Plausible's
//     daily-unique hash is computed against the real visitor, not the
//     Worker's edge IP. Plausible itself never stores the raw IP.
//   - User-Agent is forwarded for the same reason (UA goes into the
//     same anonymous hash and is then discarded).
//   - We do NOT forward cookies, query strings beyond the page URL,
//     auth headers, or anything else.
//
// Rate-limited at the router (60/min per IP — see "pageview" bucket in
// src/index.js). The pixel is fire-and-forget — even if the upstream
// POST fails, we still return the GIF so the page never shows a broken
// image.

const TRANSPARENT_GIF = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00,
  0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00,
  0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
  0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
]);

const PIXEL_HEADERS = {
  "content-type": "image/gif",
  // Don't let intermediaries cache the pixel — every pageview should
  // round-trip so the count stays accurate.
  "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
  "pragma": "no-cache",
};

export async function pageviewPixelHandler(request, env, ctx) {
  // Always reply with the GIF — analytics must never break page rendering.
  const respond = () =>
    new Response(TRANSPARENT_GIF, { status: 200, headers: PIXEL_HEADERS });

  try {
    const url = new URL(request.url);
    const pageUrl = url.searchParams.get("u");
    const domain  = url.searchParams.get("d");
    if (!pageUrl || !domain) return respond();

    // Sanity-check the domain matches what we configured for the site —
    // stops randos from pointing the pixel at our worker to inflate
    // *their* Plausible counts.
    const allowed = (env.ANALYTICS_DOMAIN || "algosize.com").toLowerCase();
    if (domain.toLowerCase() !== allowed) return respond();

    const endpoint = (env.PLAUSIBLE_ENDPOINT || "https://plausible.io").replace(/\/+$/, "");
    const ip = request.headers.get("CF-Connecting-IP")
            || request.headers.get("X-Forwarded-For")
            || "";
    const ua = request.headers.get("User-Agent") || "";

    const upstream = fetch(`${endpoint}/api/event`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": ua,
        "x-forwarded-for": ip,
      },
      body: JSON.stringify({
        name: "pageview",
        url: pageUrl,
        domain,
      }),
    }).catch(() => null);

    // Fire-and-forget: don't block the pixel response on Plausible.
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(upstream);
    }
  } catch (_e) {
    // Swallow — the pixel must always render.
  }
  return respond();
}
