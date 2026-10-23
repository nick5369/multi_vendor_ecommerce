#pragma once
#include <memory>
#include <optional>
#include <vector>

#include "Config.h"
#include "Http.h"
#include "Util.h"

namespace pay {

struct ProviderPayment {
    std::string id, orderId, status;  // status: created | authorized | captured | failed | refunded
    int64_t amount = 0;
};

struct ProviderRefund {
    std::string id, status;  // status: pending | processed | failed
};

/** The provider answered with an HTTP error. 4xx answers are final; anything else leaves the outcome unknown. */
struct ProviderError : std::exception {
    int status;
    std::string description;
    ProviderError(int s, std::string d) : status(s), description(std::move(d)) {}
    bool definitive() const { return status >= 400 && status < 500; }
    const char *what() const noexcept override { return description.c_str(); }
};

/**
 * Everything the service needs from a payment provider. Razorpay is the real implementation (TEST mode only);
 * MockGateway exists solely for offline development and is only selected by PAYMENT_GATEWAY=mock.
 */
class PaymentGateway {
  public:
    virtual ~PaymentGateway() = default;
    virtual std::string name() const = 0;
    virtual drogon::Task<std::string> createOrder(int64_t amountPaise, std::string receipt) = 0;
    virtual drogon::Task<std::optional<std::string>> findOrderByReceipt(std::string receipt) = 0;
    virtual drogon::Task<std::vector<ProviderPayment>> listOrderPayments(std::string providerOrderId) = 0;
    virtual drogon::Task<ProviderPayment> capture(ProviderPayment payment) = 0;
    virtual drogon::Task<ProviderRefund> refund(std::string paymentId, int64_t amountPaise, std::string receipt) = 0;
    virtual drogon::Task<std::optional<ProviderRefund>> findRefundByReceipt(std::string paymentId, std::string receipt) = 0;
};

// ---------------------------------------------------------------------------------------------------- Razorpay
// API contract verified against the live TEST API and razorpay.com/docs:
//   Auth: HTTP Basic (key_id:key_secret)      Base URL: https://api.razorpay.com/v1
//   POST /orders {amount,currency,receipt}    GET /orders?receipt=   GET /orders/{id}/payments
//   POST /payments/{id}/capture {amount,currency}
//   POST /payments/{id}/refund {amount,receipt}   GET /payments/{id}/refunds   (receipt acts as idempotency key)
class RazorpayGateway : public PaymentGateway {
  public:
    explicit RazorpayGateway(const Config &cfg)
        : auth_("Basic " + drogon::utils::base64Encode(cfg.razorpayKeyId + ":" + cfg.razorpayKeySecret)) {}

    std::string name() const override { return "razorpay"; }

    drogon::Task<std::string> createOrder(int64_t amountPaise, std::string receipt) override {
        Json::Value body(Json::objectValue);
        body["amount"] = static_cast<Json::Int64>(amountPaise);
        body["currency"] = "INR";
        body["receipt"] = receipt;
        auto res = co_await call(drogon::Post, "/v1/orders", &body);
        co_return res.json["id"].asString();
    }

    drogon::Task<std::optional<std::string>> findOrderByReceipt(std::string receipt) override {
        std::map<std::string, std::string> query;
        query["receipt"] = receipt;
        query["count"] = "1";
        auto res = co_await call(drogon::Get, "/v1/orders", nullptr, query);
        std::optional<std::string> found;
        const auto &items = res.json["items"];
        if (items.isArray() && !items.empty()) found = items[0]["id"].asString();
        co_return found;
    }

    drogon::Task<std::vector<ProviderPayment>> listOrderPayments(std::string providerOrderId) override {
        auto res = co_await call(drogon::Get, "/v1/orders/" + providerOrderId + "/payments");
        std::vector<ProviderPayment> out;
        for (const auto &p : res.json["items"]) out.push_back(parsePayment(p));
        co_return out;
    }

    drogon::Task<ProviderPayment> capture(ProviderPayment payment) override {
        Json::Value body(Json::objectValue);
        body["amount"] = static_cast<Json::Int64>(payment.amount);
        body["currency"] = "INR";
        auto res = co_await call(drogon::Post, "/v1/payments/" + payment.id + "/capture", &body);
        co_return parsePayment(res.json);
    }

    drogon::Task<ProviderRefund> refund(std::string paymentId, int64_t amountPaise, std::string receipt) override {
        Json::Value body(Json::objectValue);
        body["amount"] = static_cast<Json::Int64>(amountPaise);
        body["receipt"] = receipt;
        auto res = co_await call(drogon::Post, "/v1/payments/" + paymentId + "/refund", &body);
        co_return ProviderRefund{res.json["id"].asString(), res.json["status"].asString()};
    }

    drogon::Task<std::optional<ProviderRefund>> findRefundByReceipt(std::string paymentId, std::string receipt) override {
        auto res = co_await call(drogon::Get, "/v1/payments/" + paymentId + "/refunds");
        std::optional<ProviderRefund> found;
        for (const auto &r : res.json["items"])
            if (r["receipt"].asString() == receipt) found = ProviderRefund{r["id"].asString(), r["status"].asString()};
        co_return found;
    }

  private:
    std::string auth_;

    static ProviderPayment parsePayment(const Json::Value &p) {
        return ProviderPayment{p["id"].asString(), p["order_id"].asString(), p["status"].asString(), p["amount"].asInt64()};
    }

    drogon::Task<HttpResult> call(drogon::HttpMethod method, std::string path, const Json::Value *body = nullptr,
                                  std::map<std::string, std::string> query = {}) {
        std::map<std::string, std::string> headers;
        headers["Authorization"] = auth_;
        auto res = co_await sendHttp("https://api.razorpay.com", method, path, headers, body, query);
        if (res.status < 200 || res.status >= 300) {
            std::string desc = res.json["error"]["description"].asString();
            throw ProviderError(res.status, desc.empty() ? "provider error" : desc);
        }
        co_return res;
    }
};

// ---------------------------------------------------------------------------------------------------- Mock
/** Offline stand-in. State lives in mock_gateway_payments; test payments are created via /internal/mock/payments. */
class MockGateway : public PaymentGateway {
  public:
    std::string name() const override { return "mock"; }

    drogon::Task<std::string> createOrder(int64_t, std::string) override {
        std::string id = drogon::utils::getUuid();
        id.erase(std::remove(id.begin(), id.end(), '-'), id.end());
        co_return "order_mock_" + id.substr(0, 20);
    }

    drogon::Task<std::optional<std::string>> findOrderByReceipt(std::string receipt) override {
        auto db = drogon::app().getDbClient("default");
        auto r = co_await db->execSqlCoro("SELECT provider_order_id FROM payment_attempts WHERE id = $1::uuid AND provider_order_id IS NOT NULL", receipt);
        std::optional<std::string> found;
        if (!r.empty()) found = r[0][0].as<std::string>();
        co_return found;
    }

    drogon::Task<std::vector<ProviderPayment>> listOrderPayments(std::string providerOrderId) override {
        auto db = drogon::app().getDbClient("default");
        auto r = co_await db->execSqlCoro("SELECT id, status, amount_paise FROM mock_gateway_payments WHERE provider_order_id = $1 ORDER BY created_at", providerOrderId);
        std::vector<ProviderPayment> out;
        for (const auto &row : r) out.push_back(ProviderPayment{row["id"].as<std::string>(), providerOrderId, row["status"].as<std::string>(), row["amount_paise"].as<int64_t>()});
        co_return out;
    }

    drogon::Task<ProviderPayment> capture(ProviderPayment payment) override {
        auto db = drogon::app().getDbClient("default");
        co_await db->execSqlCoro("UPDATE mock_gateway_payments SET status = 'captured' WHERE id = $1 AND status = 'authorized'", payment.id);
        payment.status = "captured";
        co_return payment;
    }

    drogon::Task<ProviderRefund> refund(std::string, int64_t, std::string) override {
        co_return ProviderRefund{"rfnd_mock_" + drogon::utils::getUuid().substr(0, 14), "processed"};
    }

    drogon::Task<std::optional<ProviderRefund>> findRefundByReceipt(std::string, std::string) override {
        std::optional<ProviderRefund> none;
        co_return none;
    }
};

inline std::shared_ptr<PaymentGateway> makeGateway(const Config &cfg) {
    if (cfg.isMock()) {
        logJson("WARN", "PAYMENT_GATEWAY=mock: payments are simulated locally; this is NOT Razorpay verification");
        return std::make_shared<MockGateway>();
    }
    return std::make_shared<RazorpayGateway>(cfg);
}

}  // namespace pay
