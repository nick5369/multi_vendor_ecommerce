# PROGRESS

## Milestone A — Foundation  (status: infrastructure containers verified running; app services not built yet)
Done
- [x] Monorepo layout, `.gitignore` (protects `.env`, keys, backups)
- [x] `compose.yaml`: gateway, web, 5 app services, 5 DB containers (mongo, 3x postgres, mysql), redis (AOF, password, cache-only), rabbitmq, prometheus, grafana
- [x] Named volumes for every stateful container; pinned image tags; `backend` network is `internal: true`; `public` network for gateway/web/host ports/Razorpay egress (payment-service only)
- [x] `.env.example` (every variable commented), `scripts/gen-secrets.sh` (random secrets + RS256 keypair)
- [x] Traefik file-provider routing for /api/{auth,catalog,orders,inventory,payments}, prefix stripping, CORS, auth rate limit
- [x] Prometheus scrape config, Grafana datasource, RabbitMQ conf, Mongo app-user init script

Checked
- `docker compose config -q` with generated `.env` -> OK (this validates syntax/interpolation only)
- `scripts/gen-secrets.sh` -> OK; only the 3 Razorpay vars remain empty (expected)

NOT verified
- Docker daemon was not running (`dockerDesktopLinuxEngine` pipe missing), so no image pulled, no container started, no healthcheck observed.
- Pinned image tags (traefik v3.1.6, mongo 7.0.14, postgres 16.4-alpine, mysql 8.4.2, redis 7.4.0-alpine, rabbitmq 3.13.7, prometheus v2.54.1, grafana 11.2.2) have not been pulled; confirm on first `docker compose pull`.
- `compose.yaml` references build contexts (`frontend`, `services/*`) that are still empty; `up --build` will fail until Milestone B.

Open issues / decisions
- Razorpay webhook secret/keys must be supplied by the user (test mode). `PAYMENT_GATEWAY=mock` is the explicit dev fallback.
- Frontend token strategy to decide in Milestone F (HttpOnly cookie via gateway vs. in-memory access token + refresh cookie).

## Next
1. Start Docker Desktop, then `docker compose pull` and `docker compose up -d mongodb catalog-postgres mysql inventory-postgres payment-postgres redis rabbitmq prometheus grafana` and confirm healthy.
2. Milestone B: skeletons + Dockerfiles (each installs `curl` for healthchecks) + health endpoints for all five services and the frontend.

## Update — infrastructure verified (Docker 29.5.3, Compose v5.1.4)
- `docker compose pull` + `up -d` of mongodb, 3x postgres, mysql, redis, rabbitmq, prometheus, grafana: all pinned tags exist; 7 healthchecked containers reached `healthy`.
- Mongo app user can authenticate; MySQL app user can connect; Redis PONG with password.
- Host reachability: Grafana /api/health 200, Prometheus /-/ready 200, RabbitMQ UI 200 (all via 127.0.0.1).
- 9 named volumes `mve_*` created.
- Still not started/verified: gateway, web, 5 app services (no code yet). Razorpay webhook secret not yet set (user will add).

## Milestone B — Service skeletons (status: DONE, verified)
- auth-service (NestJS 10 + Mongoose), catalog-service (Spring Boot 3.3.4, Java 21, Flyway, JPA, Redis starter, Actuator), order-service (Go 1.23, Gin, GORM, golang-migrate embedded SQL), inventory-service (FastAPI, SQLAlchemy 2, Alembic), payment-service (C++20, Drogon v1.9.8 built from source, psql-based migration runner), frontend (React 18 + Vite + TS served by nginx).
- Each service: multi-stage Dockerfile, non-root user, `/health` (real DB ping; catalog uses `/actuator/health`), Prometheus metrics, baseline migration (outbox_events + inbox_events).
- Verified: `docker compose up -d --build` builds and starts all 16 containers; all healthchecks `healthy`; gateway routes return 200 for all 5 `/api/*/health`; web returns 200; Prometheus shows 7/7 targets up; payment-postgres has schema_migrations + outbox/inbox tables.
- Fixed during build: invalid JSON in auth package.json; Drogon upload-dir permission errors (writable WORKDIR).
- Not yet done: Swagger/OpenAPI scaffolding, JWT/JWKS auth in non-auth services, internal-token checks, structured JSON logging with request IDs, unit tests, lint config, domain schemas. `catalog` metrics via /actuator/prometheus, `payment` metrics are a placeholder counter; rabbitmq:15692 and gateway:8080 Prometheus targets not confirmed individually.
- Payment webhook secret still empty in .env (user will add).

## Next: Milestone C — auth (register/login/refresh/JWKS/seller+admin flow), catalog (products, SKUs, categories, search, Redis cache, ownership checks), seeds.

## Milestone C — Identity & Catalog (status: DONE and tested; OpenAPI docs still pending)
Auth-service (NestJS/Mongo)
- Routes: register, verify-email, login, refresh (rotation + reuse detection), logout, profile, change-password, forgot/reset-password, apply-as-seller, seller/application, stores/:id, JWKS (`/.well-known/jwks.json`, RS256), admin: users (+status), seller-applications (approve/reject), stores (+status), audit.
- bcrypt(12) hashes; opaque refresh tokens stored as SHA-256; one-time tokens single-use via atomic update; HttpOnly SameSite=Lax refresh cookie (Secure off for plain-http localhost; body delivery only with `X-Token-Delivery: body`).
- Seller approval = idempotent steps (Mongo standalone has no multi-doc transactions); SellerApproved row written to a Mongo outbox with a unique dedupe key. **The Mongo outbox is NOT yet relayed to RabbitMQ** (open item).
- Seeds: admin from ADMIN_SEED_*; 2 demo sellers + 2 demo customers (`@demo.local`, labelled NON-PRODUCTION) when `SEED_DEMO_DATA=true`, password `DEMO_USER_PASSWORD`.
- Dev mail adapter logs verification/reset tokens to the service log (`docker compose logs auth-service`).
Catalog-service (Spring Boot/Postgres)
- Flyway V2: categories (seeded reference data), products, skus (UNIQUE seller_id+sku_code; one default SKU per variant-less product), images, CHECK constraints on paise.
- Public: categories, search (title ILIKE with escaped wildcards, category incl. children, seller, price range, sort, pagination), detail. Seller CRUD scoped to JWT `storeId` (other sellers' resources return 404). Admin moderation + category create. Internal `/internal/skus/lookup` guarded by X-Internal-Token (constant-time) and blocked at the gateway.
- Redis cache-aside for detail/list/categories, TTL 120s, invalidation after commit + generation counter for lists; Redis failures degrade to cache miss.
- Outbox + scheduled relay (SKIP LOCKED) to topic exchange `mve.events`: verified 49/49 rows published, exchange present.
- Actuator on internal port 8081 only.
Gateway: `/api/*/internal` and `/api/*/metrics` blocked (403).
Tests run (via `scripts/run-e2e.sh`, in a node container on the compose network)
- auth.test.mjs: 13/13 pass. catalog.test.mjs: 11/11 pass (after fixing a real bug it found: 1.5 was coerced to an integer price).
- Seed: `scripts/seed-demo.sh` creates 8 demo products; second run reports "exists" for all.
Not verified / open
- Seller-private content cache separation is by design (only public data cached) but has no dedicated test.
- Unit tests (jest/JUnit), lint config, OpenAPI documents, rate-limit test, forgot->reset happy-path automated test (token only appears in service logs).
- Catalog does not call Inventory for stock hints yet (Milestone D).

## Next: Milestone D — inventory-service (balances, reservations, audit, concurrency) and order-service cart (atomic upsert + idempotency keys) with 100-way concurrency tests.

## Milestone D — Cart & Inventory (status: DONE and tested)
Inventory-service (FastAPI/SQLAlchemy Core/Alembic 0002)
- Tables: inventory_balances (CHECK on_hand>=0, reserved>=0, reserved<=on_hand), reservations (UNIQUE checkout_id; RESERVED/RELEASED/COMMITTED), reservation_items, inventory_adjustments, inventory_audit_log, processed_commands, outbox/inbox.
- Reserve = one transaction: claim reservation row (ON CONFLICT DO NOTHING) -> per-SKU `UPDATE ... SET reserved=reserved+q WHERE on_hand-reserved>=q` in sorted SKU order -> any miss rolls everything back (all-or-nothing). Repeat for same checkout returns the stored reservation; different items for same checkout -> 409.
- Release/commit lock the reservation row, move state exactly once, repeats are no-ops; commit-after-release and release-after-commit -> 409.
- Seller set/adjust stock verifies SKU ownership against catalog `/internal/skus/lookup`; adjust supports Idempotency-Key via processed_commands; admin audit views; public non-authoritative `/stock?skuIds=` hint.
- Expiry policy: expired RESERVED rows are only LISTED (`/internal/reservations/expired`); inventory never auto-releases. The order service must check payment state first (to be built in Milestone E).
- Outbox relay thread (pika) publishes StockReserved / ReservationFailed / StockReleased; 248/248 rows published at last check.
Order-service cart (Go/Gin/GORM, migration 000002)
- carts (UNIQUE customer), cart_items (UNIQUE cart_id+seller_id+sku_id), cart_operation_keys (PK cart_id+idem_key, result JSON).
- Add-to-cart: Idempotency-Key required; key claimed by INSERT in the same transaction as `INSERT ... ON DUPLICATE KEY UPDATE quantity = IF(quantity+q <= max, ...)`; affected-rows 0 => max exceeded => rollback (key not consumed). Concurrent duplicates wait on the key row lock and then read the stored result. Semantics: each DISTINCT key adds `quantity` (default 1); the SAME key + same payload returns the first result; same key + different payload => 409.
- Price/seller never read from the request; cart view prices lines from the catalog on every read; unavailable lines are excluded from the subtotal.
- PUT/DELETE item, DELETE cart, GET cart. JWT verified in-service against JWKS (RS256, iss, aud, exp).
Tests (all executed): `./scripts/run-e2e.sh` -> 45 tests, 45 pass, 0 fail (auth 13, catalog 11, inventory 10, cart 11).
- Concurrency evidence: 100 distinct adds -> 1 line qty 100; 100 same-key deliveries -> qty 1 (99 replays); 100 reservations on 1 unit -> exactly 1 success; 100 on 30 units -> exactly 30; 40 opposite-order multi-SKU checkouts -> no 5xx, exactly 20 succeed.
- DB-level checks after the run: 0 duplicate cart lines, `uq_cart_line` present, 0 inventory rows violating invariants.
Not yet done / open
- Inventory demo-stock seeding (seed-demo.sh only seeds catalog); Go/Python unit tests; lint configs; OpenAPI docs; load-test report with timings (the E2E suites assert correctness under concurrency but record no latency numbers).
- Inbox consumers not written yet (needed for order saga in Milestone E). Auth's SellerApproved still not relayed.
- Test runs used a single local machine; no timing results are claimed.

## Next: Milestone E — order checkout saga (orders, seller groups, history, idempotent checkout, outbox/inbox), payment-service (Drogon) with Razorpay test integration and mock adapter, refunds, webhooks; verify Razorpay API details against official docs first.

## Milestone E — Orders, checkout saga, Razorpay payments (status: backend DONE and tested; frontend checkout is Milestone F)
Razorpay facts verified first (docs + live TEST API with your keys): Basic auth `key_id:key_secret`; `POST https://api.razorpay.com/v1/orders {amount,currency,receipt}`;
checkout signature = HMAC-SHA256(key_secret, `<server order_id>|<razorpay_payment_id>`) hex; webhook signature = HMAC-SHA256(webhook_secret, RAW body) in
`X-Razorpay-Signature`, unique id in `X-Razorpay-Event-Id`; refunds `POST /v1/payments/{id}/refund {amount (paise, min 100), receipt}`, `receipt` is a refund-side idempotency key, only captured payments.
Findings that changed the design: Razorpay does NOT dedupe orders by receipt and its order listing lags creation, so "look up by receipt after a crash" is best-effort only (see README).
NOT confirmed from fetched docs: the dashboard's exact list of webhook event names (my list is from public docs/knowledge).
Order-service (Go, migrations 000003-000004)
- Tables: orders (parent checkout), order_seller_groups, order_items (price/title/seller snapshot), order_status_history, checkout_idempotency (PK customer+key), outbox/inbox.
- Totals computed server-side from catalog prices (flat shipping per seller group, optional TAX_BPS); DB CHECKs: total = subtotal+shipping+tax-discount; refunded <= total.
- Saga: PENDING_STOCK -> STOCK_RESERVED -> PAYMENT_PENDING -> PAID -> CONFIRMED (+ FAILED/CANCELLED/REFUNDED). Every step persisted; every downstream call idempotent (inventory keyed by order id, payment by `order-<id>`); transitions are locked, validated and audited (`transitionOrder`).
- Compensation: definitive reserve/payment failure -> FAILED + release; unknown outcome -> left as is for the reconciler. Stock is released only after the payment service confirms nothing can still be paid (atomic `expire`); a late capture on a closed order is refunded in full.
- Inbox-deduped consumer for PaymentSucceeded/PaymentFailed/RefundSucceeded; outbox relay (SKIP LOCKED) publishes OrderCreated/OrderConfirmed/OrderCancelled; reconciler every 5s.
- Customer: checkout (Idempotency-Key + address), order list/detail, cancel. Seller: own paid suborders, PROCESSING->SHIPPED->DELIVERED. Admin: order list/detail. Internal: payable, groups, reconcile.
- Bug found by the real-Razorpay test and fixed: FK on checkout_idempotency made concurrent checkouts deadlock (migration 000004).
Payment-service (C++20/Drogon, migrations 0002-0004)
- All state transitions are PL/pgSQL functions = one atomic call each, with their outbox row: pay_claim_intent, pay_set_provider_order, pay_apply_captured/failed/authorized, pay_expire, pay_claim_refund, pay_refund_result, pay_handle_webhook (dedupe by provider event id + apply in one transaction).
- Unique constraints: (customer,idempotency_key), (order,purpose), provider_order_id, provider_payment_id, webhook event id, (provider_payment_id,kind), refund (attempt,key), provider_refund_id.
- RS256 JWT verification in C++ against the auth JWKS; HMAC-SHA256 + constant-time compares via OpenSSL; Razorpay adapter behind `PaymentGateway`; `MockGateway` only with PAYMENT_GATEWAY=mock; refuses to start with a non-`rzp_test_` key.
- Refund policy (admin / seller-own-share / full vs partial / cumulative cap) documented in README and tested. Sweeper reconciles stale attempts, late captures, interrupted refunds.
- Compiler notes: GCC ICE on braced temporaries inside co_await (use locals); co_await is illegal in catch (restructured).
- Bugs found by tests and fixed: Drogon double-encoded `%2F` in the RabbitMQ management path (events were not published); concurrent refund completions under-reported the cumulative total (migration 0004).
Tests executed (all green at last run)
- `scripts/run-e2e.sh`: 45/45 (auth 13, catalog 11, inventory 10, cart 11).
- `scripts/run-mock-suites.sh`: 31/31 (orders 10, payments 15, saga 6) against the MOCK gateway.
- `WITH_INTERNET=1 scripts/run-e2e.sh razorpay-smoke.mjs`: 2/2 against REAL Razorpay TEST: 20 parallel identical checkouts -> 1 order, 1 provider creation call, order verified at Razorpay (amount, currency, receipt); forged signature rejected.
- `scripts/test-unit.sh`: Go unit tests + go vet pass.
Not verified / open
- A real card payment in Razorpay's test checkout, real capture/refund calls and real webhook delivery (need a human / a public tunnel + webhook secret). RAZORPAY_WEBHOOK_SECRET is still empty in .env.
- Reservation-expiry path (PAYMENT_PENDING past its reservation window -> payment `expire` -> cancel/release) is implemented but not covered by an automated test (needs a short TTL run).
- Inventory outage during compensation (release retried by reconciler) is implemented but untested.
- No gateway rate limit on checkout yet (auth routes only). OpenAPI documents, JUnit/pytest/jest unit tests, lint configs, load-test timing report, k6/Locust runner: still open.
- Seeds: demo stock for seeded products not created yet.
Next: Milestone F frontend (customer/seller/admin) + event contracts + OpenAPI, then G (backups, persistence test, final verification).

## Milestone F — React frontend (status: DONE, exercised in a real browser)
Stack health first: `docker compose ps` showed all 16 containers up (healthy where a healthcheck exists; web/grafana/prometheus have none).
Frontend (`frontend/src`, React 18 + Vite + TS + react-router + react-query, plain CSS, light/dark)
- Token strategy (decided): access token in memory only; refresh token is the HttpOnly cookie (path /api/auth). On load the app does a silent `POST /api/auth/refresh`; refreshes are de-duplicated in `api.ts` so StrictMode/parallel 401s cannot rotate the token twice. 401 -> one refresh -> retry.
- Public: product search (text/category/sort/paging), product detail with SKU choice and approximate stock hint, login/register/forgot/reset/verify-email.
- Customer: cart, checkout (address; Idempotency-Key fixed per page visit), orders list/detail (polls while the saga is between steps, cancel, history), account (change password, apply as seller).
- Razorpay: `razorpay.ts` loads checkout.js and opens it with key id / provider order id / amount from the server's payment payload (never computed in the browser; shipping phone prefilled). The callback triple goes to `POST /api/payments/payments/verify`; only server status SUCCEEDED counts, then the page waits for CONFIRMED. "I already paid - check status" calls `/payments/sync`.
- Seller: product list/create (single SKU or variants + initial stock)/edit/status, per-SKU price and stock, own paid suborders with PROCESSING/SHIPPED/DELIVERED and refund.
- Admin: seller applications, stores, users, product moderation, orders (status filter) with refund, audit log.
Verified with Playwright (host Chromium, `tests/ui/`, see tests/ui/README.md)
- Customer: browse -> login -> reload keeps session -> add to cart -> checkout -> Razorpay modal opens (real TEST key) -> Indian test card 5267 3181 8797 5449 -> "Pay on bank's page" -> Success -> `/payments/verify` 200 -> order CONFIRMED (history PAID, CONFIRMED). First real Razorpay payment of the project.
- Seller: list, product detail, set stock, create product (initial stock applied), orders -> Mark processing. Admin: applications/stores/users/products/audit pages render; real Razorpay TEST refund of Rs 1 returned PROCESSED.
- No browser page errors, no unexpected HTTP >= 400 from the gateway during the seller/admin run.
Findings
- Razorpay rejected the 4111 1111 1111 1111 test card on this account ("International cards are not supported"): a provider setting, not an app bug. The UI hint now names the Indian test card.
- Razorpay's modal asks for a mobile number; the UI now prefills it from the checkout address phone.
- The admin order page showed "refunded Rs 0.00" right after the refund until the refetch landed (cosmetic).
Not verified / open
- Webhook delivery (secret still empty, no tunnel). Payment succeeded through the browser verify path only.
- The admin stores/users/products checks in tests/ui/seller-admin.mjs look for demo names on page 1 and fail on a DB full of e2e data (test limitation; screenshots confirmed the pages render).
- Admin approve/reject of seller applications, product moderation, user disable, seller refund and the failed-payment UI paths were not clicked.
- No cross-browser or mobile-width testing, no accessibility audit, no frontend unit tests, no OpenAPI docs.
- Observed once: re-using an already-rotated refresh cookie returned a token (possible grace window; reuse detection not re-checked).
- Demo stock: `tests/ui/seed-demo-stock.mjs` sets 50 per demo SKU (seed-demo.sh itself still seeds no inventory).

## Milestone G — Backups, persistence, final verification (status: DONE for what is listed)
- `scripts/backup.sh`: pg_dump (custom format) for the 3 Postgres DBs, mysqldump (single-transaction), mongodump (gzip archive) into `infrastructure/backups/<UTC ts>/` (gitignored) with SHA256SUMS; fails on an empty file. Redis (cache) and RabbitMQ (in flight only; events are re-sent from outbox tables) are deliberately excluded.
- `scripts/restore.sh <dir> --yes`: DESTRUCTIVE live restore (checksum-verified first, refuses without --yes). **Not run against live data** (it would overwrite it); the same dumps were restored into scratch databases instead.
- `scripts/test-persistence.sh` executed: counts before/after `docker compose down` + `up -d` identical (catalog.products 223, inventory.balances 144, payment.attempts 88, orders 112, auth.users 392; volumes kept, no -v); all services healthy again; fresh backup restored into scratch DBs with identical counts for all 5 databases, scratch DBs dropped.
- Not tested: restoring after volume loss / onto an empty stack, backup of a database under heavy write load, backup encryption/off-machine copies, retention/rotation.
