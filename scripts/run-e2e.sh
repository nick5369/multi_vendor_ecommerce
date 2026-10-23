#!/usr/bin/env bash
# Runs the E2E suites inside a node container on the internal compose network (can reach the gateway and services).
# The host needs only Docker.
# Usage: scripts/run-e2e.sh [test-file]            e.g. scripts/run-e2e.sh auth.test.mjs
#        WITH_INTERNET=1 scripts/run-e2e.sh razorpay-smoke.mjs   (also attaches the egress network, for tests that
#                                                                  call api.razorpay.com themselves)
set -euo pipefail
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1
HOST_DIR="$(pwd -W 2>/dev/null || pwd)/tests/e2e"
COMMON=(--network mve_backend --env-file .env -e BASE_URL=http://gateway:8080 -v "$HOST_DIR:/tests:ro" -w /tests)
CMD="node --test ${1:-*.test.mjs}"

if [ "${WITH_INTERNET:-0}" = "1" ]; then
  cid=$(docker create "${COMMON[@]}" node:20.17-alpine sh -c "$CMD")
  trap 'docker rm -f "$cid" >/dev/null 2>&1 || true' EXIT
  docker network connect mve_public "$cid"
  docker start -a "$cid"
else
  docker run --rm "${COMMON[@]}" node:20.17-alpine sh -c "$CMD"
fi
