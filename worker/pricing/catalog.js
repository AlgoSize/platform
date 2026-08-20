// Pricing data — an ES module, NOT a .json file, and deliberately so.
//
// This is data, not code: a single default-exported frozen literal, with no
// imports, no functions and nothing computed. scripts/test-estimator.mjs
// asserts that structurally, so the guarantee JSON gave us syntactically is
// now given by a test instead.
//
// WHY NOT .json: importing JSON from an ES module requires an import
// attribute, and there is no spelling of that attribute which works in both
// places this code has to run. Node 22 accepts only `with { type: "json" }`
// (it removed `assert`); the esbuild bundled with wrangler 3.78 accepts only
// `assert` (it predates `with`). A plain attribute-less import works in
// esbuild and throws in Node. So the catalog would build for the Worker or
// run under the tests, never both — until the estimator was actually wired
// into the router, nothing imported it and the conflict stayed invisible.
// Exporting the same literal from a .js module needs no attribute anywhere.

export default Object.freeze({
  "schemaVersion": 1,
  "catalogVersion": "2026.08.20-1",
  "currency": "USD",
  "effectiveDate": "2026-08-01",
  "lastVerified": "2026-08-19",
  "verificationStatus": "unverified-seed",
  "providers": [
    "aws",
    "digitalocean",
    "hetzner",
    "akamai-linode",
    "vultr"
  ],
  "notice": "Seed catalog. Prices are transcribed list prices, not a quote, and have not been machine-verified against the provider pricing pages. Any estimate produced from a catalog whose verificationStatus is not \"verified\" carries a stale_pricing_catalog assumption and is capped at low confidence. akamai-linode and vultr were added from a secondhand pricing pull and are thinner/more provisional than aws/digitalocean/hetzner — see each provider's verificationNotes. Scaleway is deliberately not present: the only pricing data available for it is EUR-denominated, and this catalog performs no currency conversion (see pricing/README.md). OVHcloud, Cloudflare Workers, Fly.io, Render, Railway, Lambda and RunPod are also not present — no real pricing data for them has been sourced yet. See pricing/README.md for the verification procedure."
});
