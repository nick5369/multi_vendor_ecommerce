#!/usr/bin/env bash
# Seeds DEMO catalog data through the public API (demo users are created by auth-service when SEED_DEMO_DATA=true).
# Safe to re-run. Local development only.
set -euo pipefail
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1
HOST_DIR="$(pwd -W 2>/dev/null || pwd)/tests/e2e"
docker run --rm --network mve_backend --env-file .env -e BASE_URL=http://gateway:8080 \
  -v "$HOST_DIR:/tests:ro" -w /tests node:20.17-alpine node seed-demo.mjs
