-- 0018 — versioned architecture snapshots (Architecture X-ray, Phase 1).
--
-- The X-ray has always been able to answer "what does this system look like".
-- It has never been able to answer "what changed", because nothing kept the
-- previous answer. `monitors.last_arch_keys` stores a set of finding-identity
-- keys and nothing else — enough to say "3 findings are new since last night",
-- which is what the alert email needs, and not remotely enough to draw last
-- week's graph beside this week's.
--
-- Drift is the whole point of the feature this table unblocks: a reviewer
-- asking "did this PR add a dependency on the payments database" is asking a
-- question about two graphs, and you cannot diff a graph you did not keep.
--
-- Apply with:
--   wrangler d1 execute algosize --file=migrations/0018_arch_snapshots.sql \
--     --remote --env production --config wrangler.toml
--
-- ---------------------------------------------------------------------------
-- Why the graph is one JSON column rather than node/edge tables
-- ---------------------------------------------------------------------------
-- A snapshot is written once, read whole, and never queried by column. Nobody
-- asks "select every node of kind 'queue' across all snapshots" — they ask
-- "draw snapshot X" and "diff X against Y", both of which want the entire
-- object. Normalising into arch_nodes/arch_edges would buy query shapes no
-- surface has asked for, and cost a join per render plus a fan-out delete per
-- retention sweep.
--
-- If a later phase genuinely needs cross-snapshot node queries, the JSON is
-- still the source of truth and an index table can be derived from it. Going
-- the other way — recovering a whole graph from normalised rows after the
-- shape has drifted — is the migration nobody wants to write.

CREATE TABLE IF NOT EXISTS arch_snapshots (
  snapshot_id   TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,

  -- What was analysed. All nullable: a manual upload is a pile of files with
  -- no repository behind it, and inventing "unknown/unknown" for those rows
  -- would make them look like a repo we failed to identify rather than an
  -- upload that never had one.
  repo_url      TEXT,
  branch        TEXT,
  commit_sha    TEXT,

  -- 'manual' | 'ci' | 'monitor'. Not a CHECK constraint, for the same reason
  -- notification_prefs does not constrain its pref ids: the set is a product
  -- decision that will grow, and a schema migration is the wrong tool for
  -- changing one's mind about it. The write path validates instead.
  source        TEXT NOT NULL,
  captured_at   INTEGER NOT NULL,          -- unix SECONDS, like monitors

  -- The graph itself. See src/arch/snapshots.js for the encoding: gzip then
  -- base64 when the runtime offers CompressionStream, plain JSON otherwise.
  -- `encoding` says which, so a reader never has to guess by sniffing.
  graph_json    TEXT NOT NULL,
  encoding      TEXT NOT NULL,             -- 'json' | 'gzip+base64'

  -- 1 when the graph was too large to store whole and evidence arrays were
  -- dropped to fit. The reader MUST surface this: a snapshot missing its
  -- file:line citations still draws correctly and silently loses the ability
  -- to answer "where did you get that", which is the X-ray's core promise.
  reduced       INTEGER NOT NULL DEFAULT 0,

  node_count    INTEGER NOT NULL,
  edge_count    INTEGER NOT NULL,
  finding_count INTEGER NOT NULL,

  -- The snapshot this one should be diffed against — the previous capture of
  -- the same repo+branch for the same org, resolved at INSERT time.
  --
  -- Denormalised deliberately. Resolving it at read time means an ORDER BY +
  -- LIMIT over every snapshot the org has ever taken, on every render. Fixing
  -- it at write time also makes the chain STABLE: deleting a middle snapshot
  -- (retention, or an org deletion) leaves the survivors pointing at rows that
  -- may be gone, and a dangling prev_snapshot_id reads honestly as "the
  -- comparison point is no longer available" — which is true — rather than
  -- silently re-pointing at a much older graph and reporting a year of change
  -- as if it happened last night.
  prev_snapshot_id TEXT
);

-- The list query: this org's snapshots for one repo+branch, newest first.
CREATE INDEX IF NOT EXISTS idx_arch_snap_target
  ON arch_snapshots (org_id, repo_url, branch, captured_at DESC);

-- The retention sweep, and the admin overview's "snapshots in the last N days".
CREATE INDEX IF NOT EXISTS idx_arch_snap_captured
  ON arch_snapshots (captured_at);
