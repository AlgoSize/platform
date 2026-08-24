// Reading architecture history.
//
//   GET /api/arch/snapshots?repoUrl=&branch=&limit=   the list
//   GET /api/arch/snapshots/:id                       one graph
//   GET /api/arch/diff?from=&to=                      what changed between two
//
// Phase 1 ships the reads and nothing that renders them. The Workspace and the
// X-ray page are unchanged; these exist so the history is queryable the moment
// it starts accumulating, and so Phase 4's "drift since last deploy" view has
// an endpoint to build against rather than a schema to guess at.
//
// Every response is org-scoped through requireOrgContext, the same helper the
// monitor and scorecard endpoints use. A snapshot id is an identifier, not a
// capability: reading another organisation's architecture would be this
// product's worst possible bug, so the org is part of every query rather than
// something checked afterwards.

import { requireOrgContext } from "./monitors.js";
import { listSnapshots, getSnapshot, diffGraphs } from "../arch/snapshots.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// GET /api/arch/snapshots
// ---------------------------------------------------------------------------
export async function listArchSnapshotsHandler(request, env) {
  const ctxOrg = await requireOrgContext(request, env);
  if (ctxOrg.error) return ctxOrg.error;

  const url = new URL(request.url);
  // `undefined` and `null` mean different things to listSnapshots: undefined
  // omits the filter entirely, null matches rows whose column IS NULL — which
  // is how a caller asks for manual uploads, the ones with no repo behind
  // them. `?repoUrl=` with an empty value is that request, spelled.
  const repoUrl = url.searchParams.has("repoUrl")
    ? (url.searchParams.get("repoUrl") || null) : undefined;
  const branch = url.searchParams.has("branch")
    ? (url.searchParams.get("branch") || null) : undefined;
  const limit = parseInt(url.searchParams.get("limit") || "50", 10);

  const snapshots = await listSnapshots(env, ctxOrg.orgId, {
    repoUrl, branch, limit: Number.isFinite(limit) ? limit : 50,
  });

  return jsonResponse({
    snapshots,
    // Said out loud so an empty list is never mistaken for "this org has no
    // architecture". Snapshots start at the first run AFTER migration 0018;
    // every X-ray before that produced a result and kept no graph.
    basis: "One row per architecture run — manual, CI or nightly sweep — since snapshot history was added.",
  });
}

// ---------------------------------------------------------------------------
// GET /api/arch/snapshots/:id
// ---------------------------------------------------------------------------
export async function getArchSnapshotHandler(request, env) {
  const ctxOrg = await requireOrgContext(request, env);
  if (ctxOrg.error) return ctxOrg.error;

  const id = request.params && request.params.id;
  if (!id) return jsonResponse({ error: "invalid_request", message: "No snapshot id supplied." }, 400);

  const snap = await getSnapshot(env, ctxOrg.orgId, id);
  if (!snap) {
    return jsonResponse({ error: "not_found", message: "No snapshot with that id on this organisation." }, 404);
  }
  if (snap.unreadable) {
    // The row exists and its graph cannot be decoded. Reported as its own
    // state rather than as a 404 or an empty graph: "we have this and cannot
    // read it" is a different fact from "we never had it", and only one of
    // them is a bug worth chasing.
    return jsonResponse({
      error: "snapshot_unreadable",
      message: "This snapshot's stored graph could not be decoded.",
      snapshot: { ...snap, graph: undefined },
    }, 500);
  }
  return jsonResponse({ snapshot: snap });
}

// ---------------------------------------------------------------------------
// GET /api/arch/diff?from=&to=
// ---------------------------------------------------------------------------
//
// `to` alone is the common case: diff a snapshot against whatever came before
// it, which is the comparison prev_snapshot_id already recorded at write time.
export async function archDiffHandler(request, env) {
  const ctxOrg = await requireOrgContext(request, env);
  if (ctxOrg.error) return ctxOrg.error;

  const url = new URL(request.url);
  const toId = url.searchParams.get("to");
  if (!toId) {
    return jsonResponse({ error: "invalid_request", message: "Provide `to` — the snapshot to diff." }, 400);
  }

  const to = await getSnapshot(env, ctxOrg.orgId, toId);
  if (!to) {
    return jsonResponse({ error: "not_found", message: "No snapshot with that id on this organisation." }, 404);
  }

  const fromId = url.searchParams.get("from") || to.prevSnapshotId;
  const from = fromId ? await getSnapshot(env, ctxOrg.orgId, fromId) : null;

  const diff = diffGraphs(from && from.graph, to.graph);

  return jsonResponse({
    from: from ? { ...from, graph: undefined } : null,
    to:   { ...to, graph: undefined },
    diff,
    // The honest framing of an incomparable result. A first snapshot has
    // nothing before it, and that is not the same as a diff that ran and found
    // no changes — the UI must render the two differently or it will report a
    // brand-new repository as "nothing changed".
    note: diff.comparable
      ? null
      : (to.prevSnapshotId && !from
          ? "The comparison point is no longer available — it may have passed the 90-day retention window."
          : "This is the earliest snapshot for that target, so there is nothing to compare it against."),
    // A reduced snapshot dropped its evidence to fit. The diff is still
    // structurally correct; what it cannot do is cite a file and line for a
    // change, and a reader deserves to know that before asking why.
    reducedInputs: [
      ...(from && from.reduced ? [from.snapshotId] : []),
      ...(to.reduced ? [to.snapshotId] : []),
    ],
  });
}
