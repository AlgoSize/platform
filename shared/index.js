// Shared constants used by both the Jekyll frontend and the Worker API.
// Keep this file dependency-free — it is consumed by browser JS and the
// Cloudflare Worker without a bundler.

export const API_PATHS = Object.freeze({
  CHECKOUT: "/api/checkout",
  STRIPE_WEBHOOK: "/api/stripe/webhook",
  ME: "/api/me",
  LOGOUT: "/api/logout",
  ANALYZE_COST: "/api/analyze/cost",
  ANALYZE_VULN: "/api/analyze/vuln",
  ANALYZE_ALGO: "/api/analyze/algo",
});

export const SUB_STATUS = Object.freeze({
  ACTIVE: "active",
  CANCELLED: "cancelled",
});
