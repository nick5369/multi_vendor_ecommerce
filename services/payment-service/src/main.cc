#include <drogon/drogon.h>

#include <array>
#include <atomic>
#include <memory>
#include <regex>

#include "Config.h"
#include "Gateway.h"
#include "Jwt.h"
#include "PaymentService.h"
#include "Util.h"

using namespace drogon;
using namespace pay;

namespace {

std::array<std::atomic<unsigned long>, 6> statusCounters{};  // index = status class (1xx..5xx), [0] unused

const std::regex kUuid("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$");
const std::regex kIdemKey("^[A-Za-z0-9._:-]{8,100}$");

bool isUuid(const std::string &s) { return std::regex_match(s, kUuid); }

std::string lower(std::string s) {
    for (auto &c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return s;
}

std::string requestId(const HttpRequestPtr &req) {
    auto attrs = req->attributes();
    return attrs->find("rid") ? attrs->get<std::string>("rid") : std::string();
}

HttpResponsePtr jsonResponse(int status, const Json::Value &body) {
    auto resp = HttpResponse::newHttpJsonResponse(body);
    resp->setStatusCode(static_cast<HttpStatusCode>(status));
    return resp;
}

HttpResponsePtr errorResponse(const HttpRequestPtr &req, int status, const std::string &code, const std::string &message,
                              const Json::Value &details = Json::Value()) {
    return jsonResponse(status, errorBody(code, message, requestId(req), details));
}

/** Runs a handler body and converts every failure into the standard error envelope. */
template <typename F>
Task<HttpResponsePtr> guarded(HttpRequestPtr req, F body) {
    HttpResponsePtr resp;
    try {
        resp = co_await body();
    } catch (const ApiError &e) {
        resp = errorResponse(req, e.status, e.code, e.message, e.details);
    } catch (const std::exception &e) {
        Json::Value f(Json::objectValue);
        f["requestId"] = requestId(req);
        f["reason"] = e.what();
        logJson("ERROR", "unhandled error", f);
        resp = errorResponse(req, 500, "INTERNAL_ERROR", "Unexpected error");
    }
    co_return resp;
}

Task<Principal> authenticate(const HttpRequestPtr &req, JwtVerifier &jwt) {
    std::string header = req->getHeader("authorization");
    if (header.rfind("Bearer ", 0) != 0) throw ApiError(401, "UNAUTHORIZED", "Missing bearer token");
    auto principal = co_await jwt.verify(header.substr(7));
    if (!principal) throw ApiError(401, "UNAUTHORIZED", "Invalid or expired token");
    co_return *principal;
}

void requireInternal(const HttpRequestPtr &req, const Config &cfg) {
    if (!constantTimeEquals(cfg.internalToken, req->getHeader("x-internal-token"))) throw ApiError(403, "FORBIDDEN", "Internal endpoint");
}

std::string idempotencyKey(const HttpRequestPtr &req) {
    std::string key = req->getHeader("idempotency-key");
    if (!std::regex_match(key, kIdemKey)) throw ApiError(400, "VALIDATION_ERROR", "Idempotency-Key header (8-100 chars: letters, digits, . _ : -) is required");
    return key;
}

Json::Value bodyObject(const HttpRequestPtr &req) {
    auto json = req->getJsonObject();
    if (!json || !json->isObject()) throw ApiError(400, "VALIDATION_ERROR", "A JSON object body is required");
    return *json;
}

std::string requireUuidField(const Json::Value &body, const char *field) {
    if (!body[field].isString() || !isUuid(body[field].asString())) throw ApiError(400, "VALIDATION_ERROR", std::string(field) + " must be a UUID");
    return lower(body[field].asString());
}

std::string requireUuidParam(const std::string &value) {
    if (!isUuid(value)) throw ApiError(400, "VALIDATION_ERROR", "id must be a UUID");
    return lower(value);
}

int intParam(const HttpRequestPtr &req, const char *name, int fallback, int lo, int hi) {
    std::string v = req->getParameter(name);
    if (v.empty()) return fallback;
    try {
        int n = std::stoi(v);
        if (n < lo || n > hi) throw std::out_of_range("range");
        return n;
    } catch (const std::exception &) {
        throw ApiError(400, "VALIDATION_ERROR", std::string(name) + " is out of range");
    }
}

std::atomic<bool> relayBusy{false};
std::atomic<bool> sweepBusy{false};

}  // namespace

int main() {
    const Config cfg = Config::fromEnv();
    auto service = std::make_shared<PaymentService>(cfg, makeGateway(cfg));
    auto jwt = std::make_shared<JwtVerifier>(cfg);

    app().createDbClient("postgresql", cfg.dbHost, cfg.dbPort, cfg.dbName, cfg.dbUser, cfg.dbPassword, 8, "", "default");
    app().setLogLevel(trantor::Logger::kWarn);
    app().setClientMaxBodySize(256 * 1024);

    // ---------------------------------------------------------------- request id, headers, access log
    app().registerPreRoutingAdvice([](const HttpRequestPtr &req, AdviceCallback &&, AdviceChainCallback &&next) {
        std::string incoming = req->getHeader("x-request-id");
        static const std::regex safe("^[\\w-]{8,64}$");
        req->attributes()->insert("rid", std::regex_match(incoming, safe) ? incoming : utils::getUuid());
        req->attributes()->insert("t0", trantor::Date::now().microSecondsSinceEpoch());
        next();
    });
    app().registerPostHandlingAdvice([](const HttpRequestPtr &req, const HttpResponsePtr &resp) {
        resp->addHeader("X-Request-Id", requestId(req));
        resp->addHeader("X-Content-Type-Options", "nosniff");
        resp->addHeader("Cache-Control", "no-store");
        int cls = static_cast<int>(resp->statusCode()) / 100;
        if (cls >= 1 && cls <= 5) statusCounters[cls]++;
        const std::string &path = req->path();
        if (path == "/health" || path == "/metrics") return;
        Json::Value f(Json::objectValue);
        f["requestId"] = requestId(req);
        f["method"] = req->methodString();
        f["path"] = path;
        f["status"] = static_cast<int>(resp->statusCode());
        f["durationMs"] = static_cast<double>(trantor::Date::now().microSecondsSinceEpoch() - req->attributes()->get<int64_t>("t0")) / 1000.0;
        logJson("INFO", "request", f);
    });

    // ---------------------------------------------------------------- ops
    app().registerHandler(
        "/health",
        [cfgGateway = cfg.gateway](const HttpRequestPtr &, std::function<void(const HttpResponsePtr &)> &&cb) {
            auto db = app().getDbClient("default");
            auto callback = std::make_shared<std::function<void(const HttpResponsePtr &)>>(std::move(cb));
            db->execSqlAsync(
                "SELECT 1",
                [callback, cfgGateway](const orm::Result &) {
                    Json::Value b(Json::objectValue);
                    b["status"] = "UP";
                    b["service"] = "payment-service";
                    b["db"] = "up";
                    b["gateway"] = cfgGateway;
                    (*callback)(jsonResponse(200, b));
                },
                [callback](const orm::DrogonDbException &) {
                    Json::Value b(Json::objectValue);
                    b["status"] = "DOWN";
                    b["service"] = "payment-service";
                    b["db"] = "down";
                    (*callback)(jsonResponse(503, b));
                });
        },
        {Get});

    app().registerHandler(
        "/metrics",
        [](const HttpRequestPtr &, std::function<void(const HttpResponsePtr &)> &&cb) {
            auto resp = HttpResponse::newHttpResponse();
            resp->setContentTypeString("text/plain; version=0.0.4");
            std::string text = "# TYPE payment_http_responses_total counter\n";
            for (int c = 1; c <= 5; ++c) text += "payment_http_responses_total{class=\"" + std::to_string(c) + "xx\"} " + std::to_string(statusCounters[c].load()) + "\n";
            resp->setBody(text);
            cb(resp);
        },
        {Get});

    // ---------------------------------------------------------------- customer-facing
    // Create (or fetch) the payment for an order. Idempotent per (customer, Idempotency-Key).
    app().registerHandler(
        "/payments",
        [service, jwt](HttpRequestPtr req) -> Task<HttpResponsePtr> {
            co_return co_await guarded(req, [&]() -> Task<HttpResponsePtr> {
                Principal who = co_await authenticate(req, *jwt);
                if (!who.has("CUSTOMER")) throw ApiError(403, "FORBIDDEN", "Customer role required");
                std::string key = idempotencyKey(req);
                std::string orderId = requireUuidField(bodyObject(req), "orderId");
                Json::Value out = co_await service->createIntent(who.userId, key, orderId);
                bool created = out["created"].asBool();
                out.removeMember("created");
                auto resp = jsonResponse(created ? 201 : 200, out);
                resp->addHeader("Idempotent-Replay", created ? "false" : "true");
                co_return resp;
            });
        },
        {Post});

    app().registerHandler(
        "/payments/orders/{1}",
        [service, jwt](HttpRequestPtr req, std::string orderId) -> Task<HttpResponsePtr> {
            co_return co_await guarded(req, [&]() -> Task<HttpResponsePtr> {
                Principal who = co_await authenticate(req, *jwt);
                co_return jsonResponse(200, co_await service->getForCaller(who, requireUuidParam(orderId)));
            });
        },
        {Get});

    // Checkout callback. The signature is only the first check; "paid" is decided from the provider's records.
    app().registerHandler(
        "/payments/verify",
        [service, jwt](HttpRequestPtr req) -> Task<HttpResponsePtr> {
            co_return co_await guarded(req, [&]() -> Task<HttpResponsePtr> {
                Principal who = co_await authenticate(req, *jwt);
                Json::Value b = bodyObject(req);
                for (const char *f : {"razorpay_order_id", "razorpay_payment_id", "razorpay_signature"})
                    if (!b[f].isString() || b[f].asString().empty() || b[f].asString().size() > 200) throw ApiError(400, "VALIDATION_ERROR", std::string(f) + " is required");
                co_return jsonResponse(200, co_await service->verifyCheckout(who.userId, b["razorpay_order_id"].asString(), b["razorpay_payment_id"].asString(),
                                                                             b["razorpay_signature"].asString()));
            });
        },
        {Post});

    app().registerHandler(
        "/payments/sync",
        [service, jwt](HttpRequestPtr req) -> Task<HttpResponsePtr> {
            co_return co_await guarded(req, [&]() -> Task<HttpResponsePtr> {
                Principal who = co_await authenticate(req, *jwt);
                Json::Value b = bodyObject(req);
                if (!b["razorpay_order_id"].isString() || b["razorpay_order_id"].asString().size() > 200) throw ApiError(400, "VALIDATION_ERROR", "razorpay_order_id is required");
                co_return jsonResponse(200, co_await service->sync(who.userId, b["razorpay_order_id"].asString()));
            });
        },
        {Post});

    // ---------------------------------------------------------------- refunds (ADMIN, or SELLER for their own share)
    app().registerHandler(
        "/refunds",
        [service, jwt](HttpRequestPtr req) -> Task<HttpResponsePtr> {
            co_return co_await guarded(req, [&]() -> Task<HttpResponsePtr> {
                Principal who = co_await authenticate(req, *jwt);
                if (!who.has("ADMIN") && !who.has("SELLER")) throw ApiError(403, "FORBIDDEN", "Not allowed to refund");
                std::string key = idempotencyKey(req);
                Json::Value b = bodyObject(req);
                std::string orderId = requireUuidField(b, "orderId");
                int64_t amount = 0;  // 0 = full remaining amount
                if (!b["amountPaise"].isNull()) {
                    if (!b["amountPaise"].isInt64() || b["amountPaise"].asInt64() < 100 || b["amountPaise"].asInt64() > 100000000000LL)
                        throw ApiError(400, "VALIDATION_ERROR", "amountPaise must be an integer of at least 100");
                    amount = b["amountPaise"].asInt64();
                }
                std::string reason = b["reason"].isString() ? b["reason"].asString().substr(0, 200) : "";
                Json::Value out = co_await service->requestRefund(who, orderId, amount, key, reason);
                bool created = out["created"].asBool();
                out.removeMember("created");
                auto resp = jsonResponse(created ? 201 : 200, out);
                resp->addHeader("Idempotent-Replay", created ? "false" : "true");
                co_return resp;
            });
        },
        {Post});

    for (const char *table : {"payments", "refunds"}) {
        std::string t = table;
        app().registerHandler(
            "/admin/" + t,
            [service, jwt, t](HttpRequestPtr req) -> Task<HttpResponsePtr> {
                co_return co_await guarded(req, [&]() -> Task<HttpResponsePtr> {
                    Principal who = co_await authenticate(req, *jwt);
                    if (!who.has("ADMIN")) throw ApiError(403, "FORBIDDEN", "Admin role required");
                    co_return jsonResponse(200, co_await service->listAdmin(t, intParam(req, "page", 0, 0, 1000000), intParam(req, "size", 20, 1, 100)));
                });
            },
            {Get});
    }

    // ---------------------------------------------------------------- provider webhook (signature-guarded, no JWT)
    app().registerHandler(
        "/webhooks/razorpay",
        [service](HttpRequestPtr req) -> Task<HttpResponsePtr> {
            co_return co_await guarded(req, [&]() -> Task<HttpResponsePtr> {
                Json::Value out = co_await service->handleWebhook(std::string(req->body()), req->getHeader("x-razorpay-signature"), req->getHeader("x-razorpay-event-id"));
                co_return jsonResponse(200, out);
            });
        },
        {Post});

    // ---------------------------------------------------------------- internal (blocked at the gateway)
    app().registerHandler(
        "/internal/payments",
        [service, cfg](HttpRequestPtr req) -> Task<HttpResponsePtr> {
            co_return co_await guarded(req, [&]() -> Task<HttpResponsePtr> {
                requireInternal(req, cfg);
                Json::Value b = bodyObject(req);
                std::string key = b["idempotencyKey"].asString();
                if (!std::regex_match(key, kIdemKey)) throw ApiError(400, "VALIDATION_ERROR", "idempotencyKey is invalid");
                Json::Value out = co_await service->createIntent(requireUuidField(b, "customerId"), key, requireUuidField(b, "orderId"));
                bool created = out["created"].asBool();
                out.removeMember("created");
                co_return jsonResponse(created ? 201 : 200, out);
            });
        },
        {Post});

    app().registerHandler(
        "/internal/payments/by-order/{1}",
        [service, cfg](HttpRequestPtr req, std::string orderId) -> Task<HttpResponsePtr> {
            co_return co_await guarded(req, [&]() -> Task<HttpResponsePtr> {
                requireInternal(req, cfg);
                co_return jsonResponse(200, co_await service->getByOrder(requireUuidParam(orderId)));
            });
        },
        {Get});

    app().registerHandler(
        "/internal/payments/by-order/{1}/expire",
        [service, cfg](HttpRequestPtr req, std::string orderId) -> Task<HttpResponsePtr> {
            co_return co_await guarded(req, [&]() -> Task<HttpResponsePtr> {
                requireInternal(req, cfg);
                co_return jsonResponse(200, co_await service->expire(requireUuidParam(orderId)));
            });
        },
        {Post});

    // Only meaningful with PAYMENT_GATEWAY=mock; answers 404 otherwise.
    app().registerHandler(
        "/internal/mock/payments",
        [service, cfg](HttpRequestPtr req) -> Task<HttpResponsePtr> {
            co_return co_await guarded(req, [&]() -> Task<HttpResponsePtr> {
                requireInternal(req, cfg);
                Json::Value b = bodyObject(req);
                co_return jsonResponse(201, co_await service->mockPay(b["providerOrderId"].asString(), b["outcome"].asString()));
            });
        },
        {Post});

    // ---------------------------------------------------------------- background work
    app().registerBeginningAdvice([service]() {
        app().getLoop()->runEvery(1.0, [service]() {
            if (relayBusy.exchange(true)) return;
            async_run([service]() -> Task<void> {
                try {
                    co_await service->relayOutbox();
                } catch (const std::exception &e) {
                    Json::Value f(Json::objectValue);
                    f["reason"] = e.what();
                    logJson("WARN", "outbox relay paused", f);
                }
                relayBusy = false;
            });
        });
        app().getLoop()->runEvery(5.0, [service]() {
            if (sweepBusy.exchange(true)) return;
            async_run([service]() -> Task<void> {
                try {
                    co_await service->sweep();
                } catch (const std::exception &e) {
                    Json::Value f(Json::objectValue);
                    f["reason"] = e.what();
                    logJson("WARN", "sweep paused", f);
                }
                sweepBusy = false;
            });
        });
    });

    app().addListener("0.0.0.0", cfg.port);
    app().run();
    return 0;
}
