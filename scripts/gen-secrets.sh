#!/usr/bin/env bash
# Creates .env from .env.example with random LOCAL DEV secrets and an RS256 JWT keypair.
# Refuses to overwrite an existing .env. Needs bash + openssl (Git Bash on Windows has both).
# Razorpay TEST keys cannot be generated: edit .env and paste them from the Razorpay dashboard (Test Mode).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -e .env ] && { echo ".env already exists; refusing to overwrite." >&2; exit 1; }
rnd() { openssl rand -hex 16; }
cp .env.example .env
PRIV=$(openssl genrsa 2048 2>/dev/null)
PUB=$(printf '%s' "$PRIV" | openssl rsa -pubout 2>/dev/null)
b64() { printf '%s\n' "$1" | base64 | tr -d '\n'; }
setv() { sed -i "s|^$1=.*|$1=$2|" .env; }
for k in INTERNAL_SERVICE_TOKEN MONGO_ROOT_PASSWORD MONGO_APP_PASSWORD CATALOG_DB_PASSWORD \
         MYSQL_ROOT_PASSWORD MYSQL_APP_PASSWORD INVENTORY_DB_PASSWORD PAYMENT_DB_PASSWORD \
         MOCK_GATEWAY_SECRET MOCK_WEBHOOK_SECRET REDIS_PASSWORD RABBITMQ_PASSWORD GRAFANA_ADMIN_PASSWORD ADMIN_SEED_PASSWORD; do
  setv "$k" "$(rnd)Aa1!"
done
setv JWT_PRIVATE_KEY_BASE64 "$(b64 "$PRIV")"
setv JWT_PUBLIC_KEY_BASE64 "$(b64 "$PUB")"
echo ".env created. Admin login: see ADMIN_SEED_EMAIL / ADMIN_SEED_PASSWORD in .env (local only)."
echo "Set RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET / RAZORPAY_WEBHOOK_SECRET (TEST mode) or PAYMENT_GATEWAY=mock."
