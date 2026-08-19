# Algosize

Cut cloud spend, find vulnerabilities, and optimize critical algorithms.

## Layout

```
algosize/
├── site/      # Jekyll marketing site + dashboard (vanilla CSS, no frameworks)
├── worker/    # Cloudflare Worker API (auth, Stripe, analyzers)
├── shared/    # Constants and types used by both sides
└── README.md
```

## Local development

Run each side in its own terminal.

### Frontend (Jekyll)

```bash
cd site
bundle install
bundle exec jekyll serve --host 0.0.0.0 --port 5000 --livereload
```

The Replit `Start application` workflow runs this for you on port 5000.

### Worker (Cloudflare)

```bash
cd worker
npm install
npx wrangler dev    # http://localhost:8787
```

## Configuration

Copy `.env.example` to `.env` (for local notes — Cloudflare secrets are set
via `wrangler secret put`, not env files).

## Testing

- **Manual smoke test** — `TESTING.md` is the human-driven happy-path
  walkthrough (landing → checkout → dashboard → analyzers → logout).
- **Automated end-to-end** — `tests/e2e/` is a Playwright suite that runs
  the same happy path headlessly against `bundle exec jekyll serve` and
  `wrangler dev` (both spawned by the test runner). Run it locally with:

  ```bash
  cd tests/e2e
  npm install
  npx playwright install --with-deps chromium   # first run only
  npx playwright test
  ```

  The suite also runs in CI on every push / PR that touches `site/**`,
  `worker/**`, or `tests/e2e/**` — see `.github/workflows/e2e.yml`.

### Running the optimizer in CI

`.github/workflows/algorithm-optimizer.yml` runs the algorithm optimizer's
Big-O audit on every pull request, through the same core module the
dashboard's Algorithm optimizer panel uses (`worker/src/analyzers/optimizer.js`
— in-process sandbox, probe at n = 100 / 1,000 / 10,000, log-log fit):

```bash
cd worker
npm run optimizer:ci            # audit entries whose file changed vs origin/main
npm run optimizer:ci -- --all   # audit every configured entry
```

**Which functions get audited** is declared in `optimizer.config.json` at the
repo root — one entry per function, with a repo-relative `file`, the
`functionName` to extract, a JSON `sampleInput`, and a `baseline` complexity
ceiling. Entries must be SELF-CONTAINED functions the sandbox will accept: no
imports, no closures over file-level helpers, none of the sandbox's forbidden
identifiers (`async`, `Promise`, `fetch`, `constructor`, …). Set baselines one
bucket above the true complexity — they are ceilings for catching real
regressions (O(n) → O(n²)), and the headroom keeps timing noise at the fixed
probe sizes from ever failing a build.

The check fails (exit 1) on a measured regression past a baseline or a broken
config entry; a measured `unknown` warns without failing. The full report
lands in `optimizer-report.json` (uploaded as a build artifact) and as a
sticky PR comment.

**Refactor suggestions** are off in CI by default
(`ENABLE_REFACTOR_SUGGESTIONS: "false"` in the workflow). Flipping it on
routes through Workers AI (Kimi K2.5) using the `CLOUDFLARE_ACCOUNT_ID` +
`CLOUDFLARE_AI_TOKEN` Actions secrets (a token with the Workers AI
permission — the deploy token does not have it), falling back to
`OPENAI_API_KEY`. A missing secret degrades to a console notice and stub text
in the report, never a red build. The deployed Worker needs none of these:
its suggestions and the per-finding "Generate fix" button use the keyless
`[ai]` binding in `worker/wrangler.toml`.

## Deployment

See `DEPLOY.md` (added by Task #10) for the production checklist.
