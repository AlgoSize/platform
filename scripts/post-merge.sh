#!/bin/bash
# Post-merge setup for Algosize.
#
# Runs automatically after a task merges. Reconciles dependencies in both
# halves of the monorepo so the next workflow start picks up any new
# packages introduced by the merged task.
#
# Idempotent (safe to re-run) and non-interactive (stdin is closed by the
# runner — no prompts allowed).
#
# What it does NOT do:
#   - Run tests. Worker tests live in `worker/scripts/test-*.mjs` and are
#     invoked by `npm test`; running them in post-merge would make every
#     merge wait several seconds for no reconciliation benefit.
#   - Touch any database. There is none — Algosize state lives in two
#     Cloudflare KV namespaces (SESSIONS, USERS) which are remote.
#   - Restart workflows. The platform reconciles workflows on its own
#     after this script returns.

set -euo pipefail

echo "post-merge: reconciling worker dependencies"
if [ -f worker/package.json ] && [ -f worker/package-lock.json ]; then
  ( cd worker && npm ci --silent --no-audit --no-fund --prefer-offline )
elif [ -f worker/package.json ]; then
  ( cd worker && npm install --silent --no-audit --no-fund --prefer-offline )
else
  echo "post-merge: worker/package.json missing, skipping"
fi

echo "post-merge: reconciling site (Jekyll) dependencies"
if [ -f site/Gemfile ]; then
  ( cd site && bundle install --quiet --jobs=4 )
else
  echo "post-merge: site/Gemfile missing, skipping"
fi

echo "post-merge: done"
