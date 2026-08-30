// Line diff + blast radius for fix proposals.
//
// Proposals carry FULL replacement file content (see schemas.js for why —
// model-authored diffs mis-anchor silently; a full file either is or is not
// what the model meant). The platform therefore computes its own diff from
// ground truth, and that diff serves three consumers:
//
//   the UI          a reviewable preview
//   the CLI         a `git apply`-able patch
//   the validator   the blast radius — HOW MUCH a fix touches is itself a
//                   safety signal: a one-line fix to a one-line finding and a
//                   300-line rewrite of the same file are different proposals
//                   even when both scan clean
//
// The algorithm is a longest-common-prefix/suffix trim yielding one hunk per
// file. Deliberately not Myers: a security fix is overwhelmingly a contiguous
// edit, the single-hunk form is exact for that case (and merely coarser, never
// wrong, for scattered edits — the hunk grows to span them), and the O(n)
// cost keeps diffing free at request time. The trade is labelled in the
// output (`granularity: "single-hunk"`) so a consumer that needs minimal
// hunks knows this is not that.

/**
 * Unified diff for one file, plus counts.
 *
 * @returns {{ patch: string, linesAdded: number, linesRemoved: number, changed: boolean }}
 */
export function diffFile(path, before, after) {
  if (before === after) {
    return { patch: "", linesAdded: 0, linesRemoved: 0, changed: false };
  }
  const a = String(before).split("\n");
  const b = String(after).split("\n");

  // Common prefix…
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  // …and suffix, never overlapping the prefix.
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

  const removed = a.slice(start, endA);
  const added   = b.slice(start, endB);

  // Three lines of context on each side, clamped to the file.
  const ctxBefore = a.slice(Math.max(0, start - 3), start);
  const ctxAfter  = a.slice(endA, Math.min(a.length, endA + 3));

  const oldStart = Math.max(1, start - ctxBefore.length + 1);
  const newStart = oldStart;
  const oldCount = ctxBefore.length + removed.length + ctxAfter.length;
  const newCount = ctxBefore.length + added.length + ctxAfter.length;

  const lines = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    ...ctxBefore.map((l) => ` ${l}`),
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
    ...ctxAfter.map((l) => ` ${l}`),
  ];

  return {
    patch: lines.join("\n") + "\n",
    linesAdded: added.length,
    linesRemoved: removed.length,
    changed: true,
  };
}

/**
 * Diff a whole proposal against its task, producing the combined patch and
 * the blast radius the validator and audit record store.
 */
export function diffProposal(task, proposal) {
  const beforeByPath = new Map((task.files || []).map((f) => [f.path, f.content]));
  let patch = "";
  let linesAdded = 0, linesRemoved = 0, filesChanged = 0, hunks = 0;
  const perFile = [];

  for (const f of proposal.files || []) {
    const before = beforeByPath.get(f.path);
    // The allowlist was enforced at toFixProposal; an unknown path here is a
    // programming error upstream, not user input — surface it hard.
    if (before === undefined) throw new Error(`diffProposal: ${f.path} not in task`);
    const d = diffFile(f.path, before, f.content);
    if (!d.changed) { perFile.push({ path: f.path, changed: false }); continue; }
    patch += d.patch;
    linesAdded += d.linesAdded;
    linesRemoved += d.linesRemoved;
    filesChanged++;
    hunks++;
    perFile.push({ path: f.path, changed: true, linesAdded: d.linesAdded, linesRemoved: d.linesRemoved });
  }

  return {
    patch,
    blastRadius: {
      files: filesChanged,
      linesAdded,
      linesRemoved,
      hunks,
      granularity: "single-hunk",
      perFile,
    },
  };
}
