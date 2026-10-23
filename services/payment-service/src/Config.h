#pragma once
#include <string>

#include "Util.h"

namespace pay {

struct Config {
    uint16_t port;
    std::string dbHost, dbName, dbUser, dbPassword;
    uint16_t dbPort;
    std::string jwksUrl, jwtIssuer, jwtAudience;
    std::string orderUrl;
    std::string internalToken;
    std::string rabbitHttpOrigin;  // management API origin, e.g. http://rabbitmq:15672
    std::string rabbitBasicAuth;   // base64(user:password)
    std::string gateway;           // "razorpay" or "mock"
    std::string razorpayKeyId, razorpayKeySecret, razorpayWebhookSecret;
    std::string mockSecret, mockWebhookSecret;

    bool isMock() const { return gateway == "mock"; }
    /** Secret used to verify checkout signatures. */
    const std::string &signatureSecret() const { return isMock() ? mockSecret : razorpayKeySecret; }
    const std::string &webhookSecret() const { return isMock() ? mockWebhookSecret : razorpayWebhookSecret; }
    /** The key id the browser needs to open Razorpay Checkout. Never the secret. */
    std::string publicKeyId() const { return isMock() ? "mock_key_id" : razorpayKeyId; }

    static Config fromEnv() {
        Config c;
        c.port = static_cast<uint16_t>(std::stoi(envOr("PORT", "8085")));
        c.dbHost = requireEnv("DB_HOST");
        c.dbPort = static_cast<uint16_t>(std::stoi(envOr("DB_PORT", "5432")));
        c.dbName = requireEnv("DB_NAME");
        c.dbUser = requireEnv("DB_USER");
        c.dbPassword = requireEnv("DB_PASSWORD");
        c.jwksUrl = requireEnv("JWKS_URL");
        c.jwtIssuer = envOr("JWT_ISSUER", "mve-auth");
        c.jwtAudience = envOr("JWT_AUDIENCE", "mve-api");
        c.orderUrl = envOr("ORDER_URL", "http://order-service:8083");
        c.internalToken = requireEnv("INTERNAL_SERVICE_TOKEN");
        c.gateway = envOr("PAYMENT_GATEWAY", "razorpay");
        if (c.gateway != "razorpay" && c.gateway != "mock") {
            std::cerr << "PAYMENT_GATEWAY must be 'razorpay' or 'mock'" << std::endl;
            std::exit(1);
        }
        c.razorpayKeyId = envOr("RAZORPAY_KEY_ID");
        c.razorpayKeySecret = envOr("RAZORPAY_KEY_SECRET");
        c.razorpayWebhookSecret = envOr("RAZORPAY_WEBHOOK_SECRET");
        c.mockSecret = envOr("MOCK_GATEWAY_SECRET");
        c.mockWebhookSecret = envOr("MOCK_WEBHOOK_SECRET");
        if (c.isMock()) {
            if (c.mockSecret.empty() || c.mockWebhookSecret.empty()) {
                std::cerr << "mock gateway needs MOCK_GATEWAY_SECRET and MOCK_WEBHOOK_SECRET" << std::endl;
                std::exit(1);
            }
        } else {
            // Razorpay TEST mode only: refuse to start with a live key, whatever else is configured.
            if (c.razorpayKeyId.rfind("rzp_test_", 0) != 0 || c.razorpayKeySecret.empty()) {
                std::cerr << "RAZORPAY_KEY_ID must be a TEST key (rzp_test_...) and RAZORPAY_KEY_SECRET must be set" << std::endl;
                std::exit(1);
            }
        }
        // RABBITMQ_URL is amqp://user:pass@host:5672 ; the relay uses the management HTTP API on 15672
        std::string url = requireEnv("RABBITMQ_URL");
        auto at = url.find('@');
        auto scheme = url.find("://");
        std::string creds = url.substr(scheme + 3, at - scheme - 3);
        std::string host = url.substr(at + 1);
        host = host.substr(0, host.find(':'));
        c.rabbitHttpOrigin = "http://" + host + ":15672";
        c.rabbitBasicAuth = drogon::utils::base64Encode(creds);
        return c;
    }
};

}  // namespace pay
