# Multi-Vendor E-Commerce (local development)

Work in progress — see [PROGRESS.md](PROGRESS.md) for exactly what is built and verified.

## Prerequisites
Docker Desktop / Docker Engine with Compose v2. Nothing else is required on the host
(`scripts/gen-secrets.sh` uses bash + openssl; Git Bash on Windows includes both).

## Quick start
```bash
./scripts/gen-secrets.sh        # creates .env with random local secrets + JWT keypair
# edit .env: add Razorpay TEST keys, or set PAYMENT_GATEWAY=mock for offline dev
docker compose up -d --build
docker compose ps
docker compose logs -f <service>
```

## Local URLs
| What | URL |
|---|---|
| Frontend | http://localhost:5173 |
| API gateway | http://localhost:8080/api/{auth,catalog,orders,inventory,payments} |
| RabbitMQ UI | http://localhost:15672 (127.0.0.1 only) |
| Prometheus | http://localhost:9090 |
| Grafana | http://localhost:3100 |

## Data persistence
Every stateful container uses a named volume (mongo_data, catalog_pg_data, mysql_data, inventory_pg_data,
payment_pg_data, redis_data, rabbitmq_data, prometheus_data, grafana_data).

- `docker compose down` — stops containers, **keeps** data.
- `docker compose down -v` — **DESTRUCTIVE: permanently deletes all databases.**

Volumes live inside Docker's VM on your machine only: they are not backups, and are lost if Docker's
disk image is reset or deleted. Use `scripts/backup.sh` for dumps (see Backups below).
Redis holds only disposable cache data.

## Logins (local development only)
All of these exist only because `SEED_DEMO_DATA=true` / the admin seed vars are set in your local `.env`. They are labelled non-production.

| Role | Email | Password |
|---|---|---|
| Admin | `ADMIN_SEED_EMAIL` (default admin@local.test) | `ADMIN_SEED_PASSWORD` from `.env` |
| Seller (Alpha Gadgets) | seller.alpha@demo.local | `DEMO_USER_PASSWORD` from `.env` |
| Seller (Beta Home) | seller.beta@demo.local | `DEMO_USER_PASSWORD` |
| Customers | customer.one@demo.local, customer.two@demo.local | `DEMO_USER_PASSWORD` |

## Seeding and tests
```bash
./scripts/seed-demo.sh              # demo products for both sellers (idempotent)
./scripts/run-e2e.sh                # all E2E suites, run inside a container on the compose network
./scripts/run-e2e.sh catalog.test.mjs
```
Password-reset and email-verification tokens are written to the auth-service log in dev:
`docker compose logs auth-service | grep DEV_MAIL`.

## Payments (Razorpay TEST mode)
1. In the Razorpay Dashboard switch to **Test Mode**, create API keys, and put `RAZORPAY_KEY_ID` (`rzp_test_...`) and
   `RAZORPAY_KEY_SECRET` in `.env`. The payment service **refuses to start** with a non-test key id.
2. The checkout flow: the order service reserves stock, asks the payment service for a payment, the payment service reads the
   payable amount from the order service (never from the browser) and creates a Razorpay order; the browser opens Razorpay
   Checkout with the **test key id** only. The browser's callback (`razorpay_order_id`, `razorpay_payment_id`,
   `razorpay_signature`) goes to `POST /api/payments/payments/verify`; the server checks the HMAC-SHA256 signature
   (`order_id|payment_id`, constant-time compare) and then asks Razorpay for the order's real payment records. Only a
   provider-captured payment marks the order paid (an authorized payment is captured by the server first).
3. **Webhook (needed only if you want provider-pushed events).** Razorpay cannot reach `localhost`. Start a temporary HTTPS
   tunnel to the gateway yourself (for example `cloudflared tunnel --url http://localhost:8080` or `ngrok http 8080`) and register
   `https://<tunnel-host>/api/payments/webhooks/razorpay` under Dashboard > Settings > Webhooks (Test Mode) with a secret you
   choose; put the same secret in `.env` as `RAZORPAY_WEBHOOK_SECRET`, then `docker compose up -d payment-service`.
   Events handled: `payment.authorized`, `payment.captured`, `order.paid`, `payment.failed`, `refund.created`,
   `refund.processed`, `refund.failed` (select these as Active Events). The event names are taken from Razorpay's public
   documentation but were **not confirmed against the dashboard list** during development: tick what the dashboard offers.
   Without a tunnel the system still works: a background reconciler asks Razorpay for the state of unpaid attempts.
4. **Signed webhook without a tunnel:** `scripts/simulate-webhook.sh payment.captured <razorpay_order_id> <razorpay_payment_id> <amount_paise> [event_id]`
   signs the body with your webhook secret and posts it to the local gateway. Re-run with the same `event_id` to see duplicate
   protection.

### What is and is not verified against real Razorpay
Verified with your test keys: order creation (`POST /v1/orders`, Basic auth), that 20 parallel identical checkouts produce one
payment and exactly one provider-order creation call, the order's amount/currency at Razorpay, and rejection of a forged
signature (`WITH_INTERNET=1 scripts/run-e2e.sh razorpay-smoke.mjs`). **Not automated:** completing a payment in the Razorpay
test checkout (it needs a human with a test card), real capture/refund calls and real webhook delivery. Those code paths are
exercised against the clearly-labelled **mock gateway** (`PAYMENT_GATEWAY=mock`, enabled only by `scripts/run-mock-suites.sh`
or by setting the flag yourself); mock results are never evidence of Razorpay integration.

### Known provider limitations (found while testing, handled as described)
- Razorpay does not de-duplicate orders by `receipt`, and its order listing lags behind creation. One provider order per logical
  payment is guaranteed by an exclusive creation lease and by only ever exposing the persisted order id; in a crash between
  "provider order created" and "id saved", an unpaid orphan order can exist at Razorpay. Nobody receives its id, so it is never paid.
- Domain events from the payment service reach RabbitMQ through the broker's HTTP management API (no native AMQP client in the
  C++ service). Delivery is at-least-once; consumers de-duplicate on `eventId`.

### Refund policy
- ADMIN: any amount from 100 paise up to what remains refundable on the captured payment.
- SELLER: only for orders containing their seller group, up to that group's total minus what that seller already refunded.
- No amount = refund everything still refundable (full refund). Cumulative refunds can never exceed the capture.
- `Idempotency-Key` header required: repeating returns the first refund; the same key with different details is a 409.
- Money captured for an order that was already cancelled/failed is refunded in full automatically.

## Running the tests
```bash
./scripts/run-e2e.sh                                  # auth, catalog, inventory, cart (real stack)
./scripts/run-mock-suites.sh                          # orders, payments, saga using the MOCK gateway; restores Razorpay mode after
WITH_INTERNET=1 ./scripts/run-e2e.sh razorpay-smoke.mjs   # real Razorpay TEST API checks
./scripts/test-unit.sh                                # order-service unit tests (state machine, totals)
```

## Browser tests (Playwright, runs on the host)
See [tests/ui/README.md](tests/ui/README.md). Demo products have no stock until `node tests/ui/seed-demo-stock.mjs` is run.
Razorpay test card that works with this account: `5267 3181 8797 5449` (any future expiry/CVV); at the OTP step choose
"Pay on bank's page" and click Success.

## Backups
```bash
scripts/backup.sh                                   # -> infrastructure/backups/<UTC timestamp>/ (gitignored, contains real data)
scripts/test-persistence.sh                         # restart check + restore into scratch DBs (non-destructive; never uses -v)
docker compose stop auth-service catalog-service order-service inventory-service payment-service
scripts/restore.sh infrastructure/backups/<ts> --yes   # DESTRUCTIVE: overwrites live databases
docker compose start auth-service catalog-service order-service inventory-service payment-service
```
Redis and RabbitMQ are not backed up (cache / in-flight messages only).
