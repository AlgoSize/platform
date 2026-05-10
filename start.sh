#!/bin/bash
set -e

echo "=== Algosize startup ==="

# 1. Build the Jekyll site
echo "[1/2] Building Jekyll site..."
cd site
bundle exec jekyll build --destination ../_site_build --quiet
cd ..
echo "  Jekyll build complete."

# 2. Start the unified Node.js server
echo "[2/2] Starting API + static server on port 5000..."
cd worker
node server.js
