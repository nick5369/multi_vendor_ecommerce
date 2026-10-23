#!/usr/bin/env bash
# Sends a signed webhook to the local payment service using the webhook secret from .env.
#   scripts/simulate-webhook.sh payment.captured order_XXXX pay_XXXX 29900
# Uses RAZORPAY_WEBHOOK_SECRET (or MOCK_WEBHOOK_SECRET when PAYMENT_GATEWAY=mock). The secret never leaves the machine.
set -euo pipefail
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1
val() { awk -F= -v k="$1" '$1==k {sub(/^[^=]*=/, ""); split($0, a, " #"); print a[1]}' .env | tr -d '\r'; }
GATEWAY=$(val PAYMENT_GATEWAY); GATEWAY=${GATEWAY:-razorpay}
if [ "$GATEWAY" = "mock" ]; then SECRET=$(val MOCK_WEBHOOK_SECRET); else SECRET=$(val RAZORPAY_WEBHOOK_SECRET); fi
HOST_DIR="$(pwd -W 2>/dev/null || pwd)/scripts"
docker run --rm --network mve_backend -e WEBHOOK_SECRET="$SECRET" -v "$HOST_DIR:/s:ro" -w /s node:20.17-alpine node simulate-webhook.mjs "$@"
