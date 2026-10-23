#pragma once
#include <atomic>
#include <memory>

#include "Config.h"
#include "Gateway.h"
#include "Http.h"
#include "Jwt.h"
#include "Util.h"

namespace pay {

using drogon::Task;

/**
 * Payment business logic. Every state change is a single SQL function call (see migrations/0002_payments.sql),
 * so each transition together with its outbox event is atomic, and repeats are harmless.
 * The browser is never trusted: amounts come from the order service, "paid" comes from the provider's own records.
 */
class PaymentService {
  public:
    PaymentService(Config cfg, std::shared_ptr<PaymentGateway> gateway) : cfg_(std::move(cfg)), gateway_(std::move(gateway)) {}

    const Config &config() const { return cfg_; }

    // ------------------------------------------------------------------------------------------ intents
    /** Creates (or returns) the single logical payment for an order. Safe to repeat with the same key. */
    Task<Json::Value> createIntent(std::string customerId, std::string idempotencyKey, std::string orderId) {
        Json::Value payable = co_await fetchPayable(orderId);
        if (payable["customerId"].asString() != customerId) throw ApiError(404, "NOT_FOUND", "Order not found");
        int64_t amount = payable["amountPaise"].asInt64();

        auto claim = co_await fn("SELECT pay_claim_intent($1::uuid, $2, $3, $4::uuid, $5, $6)::text", customerId, idempotencyKey,
                                 sha256Hex("create-payment|" + orderId), orderId, amount, gateway_->name());
        std::string result = claim["result"].asString();
        if (result == "KEY_REUSED") throw ApiError(409, "IDEMPOTENCY_KEY_REUSED", "Idempotency-Key was already used with a different request");
        if (result == "FORBIDDEN") throw ApiError(404, "NOT_FOUND", "Order not found");

        Json::Value attempt = claim["attempt"];
        if (attempt["providerOrderId"].isNull() && attempt["status"].asString() == "INITIATING") {
            attempt = co_await ensureProviderOrder(attempt);
        }
        std::string status = attempt["status"].asString();
        if (status == "FAILED" || status == "EXPIRED") throw ApiError(409, "PAYMENT_CLOSED", "The payment for this order is closed");
        Json::Value out = checkoutPayload(attempt);
        out["created"] = claim["created"];
        co_return out;
    }

    Task<Json::Value> getByOrder(std::string orderId) {
        auto r = co_await db()->execSqlCoro("SELECT pay_attempt_json(a)::text FROM payment_attempts a WHERE a.order_id = $1::uuid", orderId);
        if (r.empty()) throw ApiError(404, "NOT_FOUND", "No payment for this order");
        co_return parseJson(r[0][0].as<std::string>());
    }

    /** Customer/admin view: only returns the attempt if it belongs to the caller (or the caller is an admin). */
    Task<Json::Value> getForCaller(const Principal &caller, std::string orderId) {
        Json::Value attempt = co_await getByOrder(orderId);
        if (!caller.has("ADMIN") && attempt["customerId"].asString() != caller.userId) throw ApiError(404, "NOT_FOUND", "No payment for this order");
        Json::Value out = checkoutPayload(attempt);
        co_return out;
    }

    Task<Json::Value> expire(std::string orderId) {
        co_return co_await fn("SELECT pay_expire($1::uuid)::text", orderId);
    }

    // ------------------------------------------------------------------------------------------ verification
    /** Checkout callback: verify the signature, then confirm with the provider before anything is marked paid. */
    Task<Json::Value> verifyCheckout(std::string customerId, std::string providerOrderId, std::string paymentId, std::string signature) {
        Json::Value attempt = co_await attemptByProviderOrder(providerOrderId);
        if (attempt.isNull() || attempt["customerId"].asString() != customerId) throw ApiError(404, "NOT_FOUND", "Payment not found");
        // Razorpay: HMAC-SHA256(key_secret, order_id + "|" + razorpay_payment_id), order_id as held by this server
        std::string expected = hmacSha256Hex(cfg_.signatureSecret(), attempt["providerOrderId"].asString() + "|" + paymentId);
        if (!constantTimeEquals(expected, signature)) {
            logJson("WARN", "checkout signature mismatch", fields({{"attemptId", attempt["attemptId"].asString()}}));
            throw ApiError(400, "INVALID_SIGNATURE", "Payment signature could not be verified");
        }
        co_return co_await syncAttempt(attempt);
    }

    /** Pull the provider's authoritative state for the caller's payment (used after failed/cancelled checkout). */
    Task<Json::Value> sync(std::string customerId, std::string providerOrderId) {
        Json::Value attempt = co_await attemptByProviderOrder(providerOrderId);
        if (attempt.isNull() || attempt["customerId"].asString() != customerId) throw ApiError(404, "NOT_FOUND", "Payment not found");
        co_return co_await syncAttempt(attempt);
    }

    // ------------------------------------------------------------------------------------------ webhooks
    Task<Json::Value> handleWebhook(std::string rawBody, std::string signature, std::string eventId) {
        if (cfg_.webhookSecret().empty()) throw ApiError(503, "WEBHOOK_NOT_CONFIGURED", "Webhook secret is not configured");
        // The signature covers the RAW bytes as received; nothing is parsed before it is verified.
        if (signature.empty() || !constantTimeEquals(hmacSha256Hex(cfg_.webhookSecret(), rawBody), signature))
            throw ApiError(400, "INVALID_SIGNATURE", "Webhook signature could not be verified");
        if (eventId.empty() || eventId.size() > 100) throw ApiError(400, "VALIDATION_ERROR", "X-Razorpay-Event-Id header is required");
        Json::Value body = parseJson(rawBody);
        if (!body.isObject() || !body["event"].isString()) throw ApiError(400, "VALIDATION_ERROR", "Malformed webhook body");

        Json::Value effect = co_await fn("SELECT pay_handle_webhook($1, $2, $3::jsonb)::text", eventId, body["event"].asString(), rawBody);
        if (effect["effect"].asString() == "LATE_REFUND_NEEDED") {
            try {
                co_await refundLate(effect["orderId"].asString());
            } catch (const std::exception &e) {
                logJson("WARN", "late refund deferred to sweeper", fields({{"reason", e.what()}}));
            }
        }
        Json::Value out(Json::objectValue);
        out["received"] = true;
        out["effect"] = effect["effect"];
        co_return out;
    }

    // ------------------------------------------------------------------------------------------ refunds
    /**
     * Refund policy:
     *  - ADMIN may refund any amount from 100 paise up to what is still refundable on the payment.
     *  - SELLER may refund only for an order that contains their seller group, up to that group's total minus
     *    what that seller already refunded. They never touch other sellers' shares.
     *  - amount omitted = refund everything still refundable (full refund). Cumulative refunds never exceed the capture.
     *  - The Idempotency-Key makes a repeat return the first refund; the same key with other details is a 409.
     */
    Task<Json::Value> requestRefund(Principal caller, std::string orderId, int64_t amountPaise, std::string key, std::string reason) {
        std::string sellerId;
        int64_t sellerCap = 0;
        if (!caller.has("ADMIN")) {
            if (!caller.has("SELLER") || caller.storeId.empty()) throw ApiError(403, "FORBIDDEN", "Not allowed to refund");
            auto groups = co_await fetchGroups(orderId);
            bool found = false;
            for (const auto &g : groups)
                if (g["sellerId"].asString() == caller.storeId) {
                    found = true;
                    sellerId = caller.storeId;
                    sellerCap = g["totalPaise"].asInt64();
                }
            if (!found) throw ApiError(404, "NOT_FOUND", "Order not found");
        }
        std::string hash = sha256Hex("refund|" + orderId + "|" + std::to_string(amountPaise) + "|" + sellerId);
        auto claim = co_await fn("SELECT pay_claim_refund($1::uuid, $2, $3, $4, $5::uuid, $6, NULLIF($7, '')::uuid, $8, $9)::text", orderId, amountPaise, key, hash,
                                 caller.userId, caller.has("ADMIN") ? std::string("ADMIN") : std::string("SELLER"), sellerId, sellerCap, reason);
        std::string result = claim["result"].asString();
        if (result == "NOT_FOUND") throw ApiError(404, "NOT_FOUND", "No payment for this order");
        if (result == "NOT_CAPTURED") throw ApiError(409, "ORDER_NOT_PAID", "Only a captured payment can be refunded");
        if (result == "KEY_REUSED") throw ApiError(409, "IDEMPOTENCY_KEY_REUSED", "Idempotency-Key was already used with a different refund request");
        if (result == "INVALID_AMOUNT") {
            Json::Value d(Json::objectValue);
            d["maxRefundablePaise"] = claim["maxRefundablePaise"];
            throw ApiError(422, "INVALID_REFUND_AMOUNT", "Refund amount must be at least 100 paise and within the refundable balance", d);
        }
        Json::Value refund = claim["refund"];
        if (refund["status"].asString() == "REQUESTED") {
            refund = co_await issueProviderRefund(refund, claim["attempt"]["providerPaymentId"].asString());
        }
        refund["created"] = claim["created"];
        co_return refund;
    }

    Task<Json::Value> listAdmin(std::string table, int page, int size) {
        const std::string sql = table == "refunds"
            ? "SELECT pay_refund_json(r)::text FROM refunds r ORDER BY r.created_at DESC LIMIT $1 OFFSET $2"
            : "SELECT pay_attempt_json(a)::text FROM payment_attempts a ORDER BY a.created_at DESC LIMIT $1 OFFSET $2";
        auto rows = co_await db()->execSqlCoro(sql, static_cast<int64_t>(size), static_cast<int64_t>(page) * size);
        auto total = co_await db()->execSqlCoro(table == "refunds" ? "SELECT count(*) FROM refunds" : "SELECT count(*) FROM payment_attempts");
        Json::Value items(Json::arrayValue);
        for (const auto &r : rows) items.append(parseJson(r[0].as<std::string>()));
        Json::Value out(Json::objectValue);
        out["items"] = items;
        out["page"] = page;
        out["size"] = size;
        out["total"] = static_cast<Json::Int64>(total[0][0].as<int64_t>());
        co_return out;
    }

    // ------------------------------------------------------------------------------------------ mock (local only)
    /** Creates a simulated provider payment and returns what a Razorpay checkout would hand back to the browser. */
    Task<Json::Value> mockPay(std::string providerOrderId, std::string outcome) {
        if (!cfg_.isMock()) throw ApiError(404, "NOT_FOUND", "Not found");
        if (outcome != "captured" && outcome != "authorized" && outcome != "failed") throw ApiError(400, "VALIDATION_ERROR", "outcome must be captured, authorized or failed");
        Json::Value attempt = co_await attemptByProviderOrder(providerOrderId);
        if (attempt.isNull()) throw ApiError(404, "NOT_FOUND", "Unknown provider order");
        std::string id = "pay_mock_" + drogon::utils::getUuid().substr(0, 14);
        co_await db()->execSqlCoro("INSERT INTO mock_gateway_payments (id, provider_order_id, amount_paise, status) VALUES ($1, $2, $3, $4)", id, providerOrderId,
                                   attempt["amountPaise"].asInt64(), outcome);
        Json::Value out(Json::objectValue);
        out["razorpay_payment_id"] = id;
        out["razorpay_order_id"] = providerOrderId;
        out["razorpay_signature"] = hmacSha256Hex(cfg_.signatureSecret(), providerOrderId + "|" + id);
        out["amountPaise"] = attempt["amountPaise"];
        co_return out;
    }

    // ------------------------------------------------------------------------------------------ background jobs
    /** Reconciles stale attempts against the provider, refunds late captures, resumes interrupted refunds. */
    Task<void> sweep() {
        auto stale = co_await db()->execSqlCoro(
            "SELECT pay_attempt_json(a)::text FROM payment_attempts a WHERE a.status IN ('CREATED', 'AUTHORIZED') AND a.provider_order_id IS NOT NULL "
            "AND a.gateway = $1 AND a.updated_at < now() - interval '15 seconds' ORDER BY a.updated_at LIMIT 20", gateway_->name());
        for (const auto &row : stale) {
            try {
                co_await syncAttempt(parseJson(row[0].as<std::string>()));
            } catch (const std::exception &e) {
                logJson("WARN", "sweep sync deferred", fields({{"reason", e.what()}}));
            }
        }
        auto late = co_await db()->execSqlCoro(
            "SELECT order_id::text FROM payment_attempts a WHERE a.needs_refund AND a.gateway = $1 AND NOT EXISTS "
            "(SELECT 1 FROM refunds r WHERE r.attempt_id = a.id AND r.status <> 'FAILED') LIMIT 20", gateway_->name());
        for (const auto &row : late) {
            try {
                co_await refundLate(row[0].as<std::string>());
            } catch (const std::exception &e) {
                logJson("WARN", "late refund deferred", fields({{"reason", e.what()}}));
            }
        }
        auto stuck = co_await db()->execSqlCoro(
            "SELECT pay_refund_json(r)::text, a.provider_payment_id FROM refunds r JOIN payment_attempts a ON a.id = r.attempt_id "
            "WHERE r.status = 'REQUESTED' AND a.gateway = $1 AND r.updated_at < now() - interval '20 seconds' LIMIT 20", gateway_->name());
        for (const auto &row : stuck) {
            try {
                co_await issueProviderRefund(parseJson(row[0].as<std::string>()), row[1].as<std::string>());
            } catch (const std::exception &e) {
                logJson("WARN", "refund resume deferred", fields({{"reason", e.what()}}));
            }
        }
    }

    /**
     * Relays committed outbox rows to RabbitMQ through its management HTTP API (this service has no native AMQP
     * client). Delivery is at-least-once: a row is marked published only after the broker accepted it, and consumers
     * de-duplicate by eventId.
     */
    Task<void> relayOutbox() {
        if (!topologyReady_) {
            co_await ensureTopology();
            topologyReady_ = true;
        }
        auto rows = co_await db()->execSqlCoro(
            "SELECT id::text, event_type, routing_key, payload::text FROM outbox_events WHERE published_at IS NULL ORDER BY created_at LIMIT 50");
        for (const auto &row : rows) {
            Json::Value body(Json::objectValue);
            Json::Value props(Json::objectValue);
            props["message_id"] = row[0].as<std::string>();
            props["type"] = row[1].as<std::string>();
            props["content_type"] = "application/json";
            props["delivery_mode"] = 2;
            body["properties"] = props;
            body["routing_key"] = row[2].as<std::string>();
            body["payload"] = row[3].as<std::string>();
            body["payload_encoding"] = "string";
            std::map<std::string, std::string> headers;
            headers["Authorization"] = "Basic " + cfg_.rabbitBasicAuth;
            auto res = co_await sendHttp(cfg_.rabbitHttpOrigin, drogon::Post, "/api/exchanges/%2F/mve.events/publish", headers, &body);
            if (res.status != 200) throw std::runtime_error("broker rejected publish");
            co_await db()->execSqlCoro("UPDATE outbox_events SET published_at = now() WHERE id = $1::uuid", row[0].as<std::string>());
        }
    }

  private:
    Config cfg_;
    std::shared_ptr<PaymentGateway> gateway_;
    bool topologyReady_ = false;

    static drogon::orm::DbClientPtr db() { return drogon::app().getDbClient("default"); }

    static Json::Value fields(std::initializer_list<std::pair<const char *, std::string>> kv) {
        Json::Value v(Json::objectValue);
        for (const auto &[k, val] : kv) v[k] = val;
        return v;
    }

    template <typename... Args>
    static Task<Json::Value> fn(std::string sql, Args... args) {
        auto r = co_await db()->execSqlCoro(sql, args...);
        co_return parseJson(r[0][0].template as<std::string>());
    }

    Json::Value checkoutPayload(const Json::Value &attempt) const {
        Json::Value out(Json::objectValue);
        out["attemptId"] = attempt["attemptId"];
        out["orderId"] = attempt["orderId"];
        out["status"] = attempt["status"];
        out["providerOrderId"] = attempt["providerOrderId"];
        out["keyId"] = cfg_.publicKeyId();  // the TEST key id only; the secret never leaves the server
        out["amountPaise"] = attempt["amountPaise"];
        out["currency"] = attempt["currency"];
        out["gateway"] = attempt["gateway"];
        return out;
    }

    Task<Json::Value> attemptByProviderOrder(std::string providerOrderId) {
        auto r = co_await db()->execSqlCoro("SELECT pay_attempt_json(a)::text FROM payment_attempts a WHERE a.provider_order_id = $1", providerOrderId);
        if (r.empty()) co_return Json::Value();
        co_return parseJson(r[0][0].as<std::string>());
    }

    // ---- calls to the order service (trusted internal contract)
    Task<Json::Value> orderGet(std::string path) {
        HttpResult res;
        try {
            std::map<std::string, std::string> headers;
            headers["X-Internal-Token"] = cfg_.internalToken;
            res = co_await sendHttp(cfg_.orderUrl, drogon::Get, path, headers);
        } catch (const std::exception &) {
            throw ApiError(503, "ORDER_SERVICE_UNAVAILABLE", "Could not reach the order service");
        }
        if (res.status == 404) throw ApiError(404, "NOT_FOUND", "Order not found");
        if (res.status == 409) throw ApiError(409, "ORDER_NOT_PAYABLE", "Order is not awaiting payment");
        if (res.status != 200) throw ApiError(503, "ORDER_SERVICE_UNAVAILABLE", "Order service returned an unexpected answer");
        co_return res.json;
    }

    Task<Json::Value> fetchPayable(std::string orderId) { co_return co_await orderGet("/internal/orders/" + orderId + "/payable"); }

    Task<Json::Value> fetchGroups(std::string orderId) { co_return co_await orderGet("/internal/orders/" + orderId + "/groups"); }

    // ---- provider order creation without ever creating two for one logical payment
    Task<Json::Value> ensureProviderOrder(Json::Value attempt) {
        const std::string attemptId = attempt["attemptId"].asString();
        for (int i = 0; i < 100; ++i) {
            auto row = co_await db()->execSqlCoro("SELECT pay_attempt_json(a)::text, a.provider_order_id IS NOT NULL FROM payment_attempts a WHERE a.id = $1::uuid", attemptId);
            Json::Value current = parseJson(row[0][0].as<std::string>());
            if (row[0][1].as<bool>() || current["status"].asString() != "INITIATING") co_return current;

            // Only one caller at a time may talk to the provider for this attempt (a short exclusive lease).
            auto lease = co_await db()->execSqlCoro(
                "UPDATE payment_attempts SET lease_until = now() + interval '30 seconds', provider_create_calls = provider_create_calls + 1 WHERE id = $1::uuid AND provider_order_id IS NULL "
                "AND status = 'INITIATING' AND (lease_until IS NULL OR lease_until < now()) RETURNING id", attemptId);
            if (lease.empty()) {
                co_await drogon::sleepCoro(drogon::app().getLoop(), 0.3);
                continue;
            }
            int failureKind = 0;  // 0 ok, 1 provider refused (final), 2 outcome unknown
            int failureStatus = 0;
            std::string failureDesc;
            Json::Value done;
            try {
                // Best-effort crash recovery: a previous run may have created the provider order before persisting its id.
                // The attempt id is the provider-side receipt. Razorpay does NOT dedupe on receipt and its order listing lags,
                // so this lookup can miss; the guarantee is the exclusive lease above plus the fact that only the persisted
                // provider_order_id is ever shown to a customer (an unpaid orphan order is harmless and is never paid).
                std::optional<std::string> existing = co_await gateway_->findOrderByReceipt(attemptId);
                std::string providerOrderId = existing ? *existing : co_await gateway_->createOrder(current["amountPaise"].asInt64(), attemptId);
                done = co_await fn("SELECT pay_set_provider_order($1::uuid, $2)::text", attemptId, providerOrderId);
            } catch (const ProviderError &e) {
                failureKind = e.definitive() ? 1 : 2;
                failureStatus = e.status;
                failureDesc = e.description;
            } catch (const std::runtime_error &) {
                failureKind = 2;
            }
            if (failureKind == 0) co_return done;
            co_await db()->execSqlCoro("UPDATE payment_attempts SET lease_until = NULL WHERE id = $1::uuid", attemptId);
            logJson("WARN", "provider order creation failed", fields({{"status", std::to_string(failureStatus)}, {"reason", failureDesc}}));
            if (failureKind == 1) throw ApiError(422, "PROVIDER_REJECTED", "The payment provider rejected the request");
            throw ApiError(502, "PROVIDER_UNAVAILABLE", "The payment provider could not be reached");
        }
        throw ApiError(503, "PAYMENT_INITIATION_BUSY", "Payment initiation is in progress; try again");
    }

    // ---- provider reconciliation: the single path that turns provider facts into our state
    Task<Json::Value> syncAttempt(Json::Value attempt) {
        const std::string providerOrderId = attempt["providerOrderId"].asString();
        std::vector<ProviderPayment> payments;
        try {
            payments = co_await gateway_->listOrderPayments(providerOrderId);
        } catch (const ProviderError &e) {
            throw ApiError(e.definitive() ? 422 : 502, "PROVIDER_ERROR", "Could not read the payment from the provider");
        } catch (const std::runtime_error &) {
            throw ApiError(502, "PROVIDER_UNAVAILABLE", "The payment provider could not be reached");
        }

        bool anyOpen = false, anyFailed = false;
        for (auto &p : payments) {
            if (p.orderId != providerOrderId) continue;
            if (p.status == "authorized") {
                // authorized money is not paid yet: capture it, then record the capture
                try {
                    p = co_await gateway_->capture(p);
                } catch (const ProviderError &e) {
                    logJson("WARN", "capture failed", fields({{"status", std::to_string(e.status)}, {"reason", e.description}}));
                    anyOpen = true;
                    continue;
                }
            }
            if (p.status == "captured") {
                Json::Value r = co_await fn("SELECT pay_apply_captured($1, $2, $3, $4::jsonb)::text", providerOrderId, p.id, p.amount, std::string("{\"source\":\"verify\"}"));
                std::string effect = r["effect"].asString();
                if (effect == "AMOUNT_MISMATCH") throw ApiError(422, "AMOUNT_MISMATCH", "Provider amount does not match the order amount");
                if (effect == "LATE_REFUND_NEEDED") co_await refundLate(r["orderId"].asString());
            } else if (p.status == "failed") {
                anyFailed = true;
            } else {
                anyOpen = true;
            }
        }
        if (anyFailed && !anyOpen) co_await fn("SELECT pay_apply_failed($1, $2)::text", providerOrderId, std::string("payment failed at provider"));

        Json::Value updated = co_await attemptByProviderOrder(providerOrderId);
        Json::Value out = checkoutPayload(updated);
        out["verified"] = true;
        co_return out;
    }

    // ---- refunds
    Task<void> refundLate(std::string orderId) {
        auto claim = co_await fn("SELECT pay_claim_refund($1::uuid, 0, 'auto-refund-late-capture', $2, '00000000-0000-0000-0000-000000000000'::uuid, 'SYSTEM', NULL, 0, "
                                 "'captured after the order was closed')::text", orderId, sha256Hex("late|" + orderId));
        if (claim["result"].asString() != "OK") co_return;
        Json::Value refund = claim["refund"];
        if (refund["status"].asString() == "REQUESTED") co_await issueProviderRefund(refund, claim["attempt"]["providerPaymentId"].asString());
    }

    Task<Json::Value> issueProviderRefund(Json::Value refund, std::string paymentId) {
        const std::string refundId = refund["refundId"].asString();
        int failureKind = 0;  // 0 ok, 1 provider refused (final), 2 outcome unknown
        std::string failureDesc;
        Json::Value done;
        try {
            // The refund id is the provider-side receipt: if an earlier run already created it, reuse that refund.
            std::optional<ProviderRefund> existing = co_await gateway_->findRefundByReceipt(paymentId, refundId);
            ProviderRefund pr = existing ? *existing : co_await gateway_->refund(paymentId, refund["amountPaise"].asInt64(), refundId);
            Json::Value r = co_await fn("SELECT pay_refund_result($1::uuid, $2, $3, '')::text", refundId, pr.id, pr.status);
            done = r["refund"];
        } catch (const ProviderError &e) {
            failureKind = e.definitive() ? 1 : 2;
            failureDesc = e.description;
        } catch (const std::runtime_error &) {
            failureKind = 2;
        }
        if (failureKind == 0) co_return done;
        if (failureKind == 1) {
            co_await fn("SELECT pay_refund_result($1::uuid, '', 'failed', $2)::text", refundId, failureDesc);
            throw ApiError(422, "REFUND_REJECTED", "The payment provider rejected the refund");
        }
        throw ApiError(502, "PROVIDER_UNAVAILABLE", "The payment provider could not be reached; repeat the request with the same Idempotency-Key");
    }

    // ---- RabbitMQ topology for the events this service publishes (idempotent declarations)
    Task<void> ensureTopology() {
        std::map<std::string, std::string> auth;
        auth["Authorization"] = "Basic " + cfg_.rabbitBasicAuth;
        Json::Value exchange(Json::objectValue);
        exchange["type"] = "topic";
        exchange["durable"] = true;
        co_await sendHttp(cfg_.rabbitHttpOrigin, drogon::Put, "/api/exchanges/%2F/mve.events", auth, &exchange);
        Json::Value queue(Json::objectValue);
        queue["durable"] = true;
        co_await sendHttp(cfg_.rabbitHttpOrigin, drogon::Put, "/api/queues/%2F/order-service.events", auth, &queue);
        const std::vector<std::string> keys{"payment.succeeded.v1", "payment.failed.v1", "refund.succeeded.v1"};
        for (const auto &key : keys) {
            Json::Value binding(Json::objectValue);
            binding["routing_key"] = key;
            co_await sendHttp(cfg_.rabbitHttpOrigin, drogon::Post, "/api/bindings/%2F/e/mve.events/q/order-service.events", auth, &binding);
        }
    }
};

}  // namespace pay
