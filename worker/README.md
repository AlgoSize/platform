# worker/

Cloudflare Worker that powers the Algosize API: auth, Stripe, and the analyzer endpoints.

## Run locally

```bash
cd worker
npm install
npx wrangler dev
```

Worker listens on `http://localhost:8787`. The `Start application` Replit
workflow runs the Jekyll site on port 5000 — start the Worker separately
in a terminal when you need the API.

## Secrets

Set with `wrangler secret put <NAME>`:

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_ID`
- `JWT_SECRET`

## Security auditor (`POST /api/analyze/vuln`)

Two modes behind one endpoint, both returning the same `summary` verdict:

| Body | Mode | What it does |
| --- | --- | --- |
| `{ repoUrl }` | dependency audit | Fetches supported lockfiles from the repo's default branch, queries OSV.dev, returns advisories with severity and fix versions |
| `{ code }` or `{ files }` | source scan | Regex detectors for secrets, injection sinks, TLS/crypto hygiene |

`summary` carries the audit verdict:

```jsonc
{
  "securityScore": 39,          // 0-100
  "grade": "F",                 // A-F
  "counts": { "critical": 1, "high": 0, "medium": 2, "low": 0, "unknown": 0 },
  "worstSeverity": "critical",
  "remediation": [              // ordered: do the first one first
    { "priority": "now", "action": "Rotate 1 exposed credential (app.js:12)…",
      "why": "A committed secret stays valid until it is rotated…" }
  ],
  "complete": true              // false ⇒ the audit hit a cap; counts are a floor
}
```

Grades are capped by the worst finding: any `critical` caps the score in the
F band, any `high` at D or below. One leaked live credential should not
score a B because the rest of the repo is tidy.

### Severity comes from the CVSS vector

OSV publishes severity as a CVSS *vector*, not a number.
`src/analyzers/cvss.js` computes the base score exactly per the FIRST specs
for CVSS v3.0/v3.1 and v2.0; v4.0 vectors are approximated via the v3
formula and flagged `severityApproximate: true`. Each advisory carries
`cvssScore`, `cvssVector` and `cvssVersion` so a reviewer can check the
arithmetic against the published vector.

### Coverage limits are reported, not hidden

An audit caps at 1000 packages queried and 100 advisories hydrated. When a
cap bites, `summary.complete` is `false` and `summary.partial` says which
one — a partial audit must never read as a clean bill of health.
