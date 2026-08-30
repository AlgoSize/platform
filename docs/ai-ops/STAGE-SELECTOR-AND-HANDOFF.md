# Stage model selector + MCP agent handoff

Three additions on top of the multi-model fix pipeline: a per-stage model
selector with a live cost estimate, a hybrid "route the fix to your own agent"
path, and the two MCP tools that make the handoff work. All built on the
existing MCP server and the recommendation/pricing registries — no second MCP
server, no parallel model config.

## Part A — the stage model selector

`GET /api/ai/models` (auth) returns, for each pipeline stage, only the models
valid for that stage's role:

| Stage | Requires | Source |
| --- | --- | --- |
| Triage | function calling (`tools`) | `recommend("triage")` filtered |
| Validation | reasoning | `recommend("vuln_classification")` filtered |
| Fix | code specialist (`coding ≥ 70`) | `recommend("multifile_fix")` filtered |
| Verify | reasoning, **≠ the fix model** | `recommend("vuln_classification")` minus fix |

The rules live in one pure module, `worker/src/ai/stages.js`
(`validModelsForStage`, `validateStageConfig`, `estimatePipelineCost`), so the
dropdowns, the cost estimate, the server-side validation, and the tests all
read the same truth. No model slug is hardcoded — the options come from the
registry, priced by `ai/pricing.js`.

**Stage 5 ≠ Stage 4 is enforced server-side.** `POST /api/ai/stage-config/validate`
returns **422** for a config where verify uses the fix model (or a model
invalid for its role). The UI shows the server's verdict; it does not decide it.
A fix graded by its own author is not a cross-check, and the client cannot be
trusted to prevent it.

**Live cost estimate.** `POST /api/ai/estimate` prices a selection per finding
using `DEFAULT_STAGE_TOKENS`, applies the 25% platform margin (so the number is
the **customer** price, consistent with the meter), and returns `null` for any
unpriced stage — never `$0` — flagging the total `partial`.

## Part C — route to MCP (the hybrid toggle)

Each stage row has a **Route to agent** toggle. Toggling it for the fix stage
runs the pipeline through Stages 1–3 on Workers AI, then **parks** each
validated finding as `waiting_for_agent` instead of calling the coding model
(`worker/src/fix/pipeline.js`, `routeToMcp` option). Workers AI is billed for
triage + validation only; the customer's own Claude Code / Kimi session does
Fix + Verify at zero Workers AI token cost — cutting the bulk of pipeline spend,
which sits in the coding + verification stages. In the cost estimate a routed
stage shows `$0`.

## Part B — the two MCP tools

Registered on the existing `/api/mcp` (no new server), in
`worker/src/mcp/tools/handoff.js`. Both go through `callHandler` like every
tool — the purity guard forbids a tool from touching `env.DB` or importing an
analyzer, so the DB work and org scoping live in handlers behind chains.

- **`algosize_get_scan_findings`** (READ) → `GET /api/fix/handoff`. Returns the
  findings from a scan run plus a ready-to-paste prompt document framed for the
  chosen agent (Claude Code / Kimi / generic MCP), optionally with best-effort
  bge-m3 similar-prior-fix chunks. Reads a run the customer already paid for;
  meters nothing.
- **`algosize_record_patch`** (MANAGE) → `POST /api/fix/patch`. Records that an
  agent applied a fix: `source: "mcp_agent"`, provenance in the new
  `scan_patches` table (migration 0027). **Stores no source** — a supplied diff
  is hashed and discarded; the row keeps the hash + a short summary, exactly as
  `AgentExecutionRecord` does. Does not bill Workers AI tokens (the agent did
  the work).

## Discipline carried through

- **No secret rendered or stored.** The handoff prompt and every tool result
  are scrubbed by the MCP `redact()`; the frontend connect note shows an
  `ASK_LIVE_KEY` env-var placeholder only, never a key (per `MCP-CONTRACT.md`).
- **org_id first** on every read/write in the two handlers (tenant rule).
- **No source in the DB** — the patch record is a hash + summary, never a diff.
- **Unmeasured ≠ zero** — an unpriced stage in the estimate is `null`, and a
  fix routed to an agent is a real `$0` (a measured zero), distinct from
  unpriced.

## Frontend

`#/pipeline` (`site/assets/js/dash-pipeline.js`, a Workspace card): per-stage
dropdowns (valid models only), the Route-to-agent toggles, the live cost panel,
inline server-validation errors, and the handoff panel (run id + agent picker →
paste-ready prompt with a copy button).

## What runs where

| Piece | Where | Access |
| --- | --- | --- |
| Stage rules, cost estimate, validation | repo | none |
| The two MCP tools + handlers + `scan_patches` | repo | none |
| Route-to-MCP parking | repo | none |
| bge-m3 handoff chunks | operator / Replit | Vectorize binding (best-effort) |
