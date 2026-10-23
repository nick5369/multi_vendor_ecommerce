#!/usr/bin/env bash
# Runs the order/payment/saga suites against the MOCK payment gateway, then restores the Razorpay gateway.
# The mock is an explicit local flag (PAYMENT_GATEWAY=mock) and is NOT Razorpay verification: for that use
#   WITH_INTERNET=1 scripts/run-e2e.sh razorpay-smoke.mjs
set -euo pipefail
cd "$(dirname "$0")/.."
GATEWAY_PORT=$(awk -F= '/^GATEWAY_PORT=/{split($2, a, " "); print a[1]}' .env | tr -d '\r')
GATEWAY_PORT=${GATEWAY_PORT:-8080}

wait_for_gateway() {
  for _ in $(seq 1 60); do
    if curl -fsS "http://localhost:${GATEWAY_PORT}/api/payments/health" 2>/dev/null | grep -q "\"gateway\":\"$1\""; then return 0; fi
    sleep 1
  done
  echo "payment-service did not come up in $1 mode" >&2
  return 1
}

restore() {
  echo "restoring PAYMENT_GATEWAY from .env"
  docker compose up -d payment-service >/dev/null
}
trap restore EXIT

echo "switching payment-service to the MOCK gateway (local testing only)"
PAYMENT_GATEWAY=mock docker compose up -d payment-service >/dev/null
wait_for_gateway mock

export MSYS_NO_PATHCONV=1
HOST_DIR="$(pwd -W 2>/dev/null || pwd)/tests/e2e"
docker run --rm --network mve_backend --env-file .env -e BASE_URL=http://gateway:8080 \
  -v "$HOST_DIR:/tests:ro" -w /tests node:20.17-alpine \
  sh -c "node --test ${*:-orders.mock.mjs payments.mock.mjs saga.mock.mjs}"
