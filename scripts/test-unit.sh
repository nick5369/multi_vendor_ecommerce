#!/usr/bin/env bash
# Runs the unit tests of services that have them, each inside its own toolchain container.
# The host needs only Docker. Currently: order-service (Go).
set -euo pipefail
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1
ROOT="$(pwd -W 2>/dev/null || pwd)"

echo "== order-service (go test) =="
docker run --rm -v "$ROOT/services/order-service:/src" -w /src golang:1.23.2-alpine \
  sh -c "go mod tidy >/dev/null 2>&1 && go vet ./... && go test ./... -count=1"
