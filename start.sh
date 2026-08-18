#!/bin/bash
set -e

echo "=== Algosize startup ==="

# 1. Install Ruby gems if needed
echo "[1/3] Installing Ruby gems..."
cd site
bundle install --quiet 2>/dev/null || bundle install
cd ..
echo "  Gems ready."

# 2. Build the Jekyll site
echo "[2/3] Building Jekyll site..."
cd site
bundle exec jekyll build --destination ../_site_build --quiet
cd ..
echo "  Jekyll build complete."

# 3. Install Node dependencies
echo "[3/4] Installing Node dependencies..."
cd worker
npm ci --silent 2>/dev/null || npm ci
cd ..
echo "  Node modules ready."

# 4. Start the unified Node.js server
echo "[4/4] Starting API + static server on port 5000..."
cd worker
node server.js
