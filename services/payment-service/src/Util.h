#pragma once
#include <drogon/drogon.h>
#include <openssl/crypto.h>
#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <openssl/sha.h>

#include <chrono>
#include <cstdlib>
#include <iostream>
#include <mutex>
#include <string>
#include <string_view>

namespace pay {

// ------------------------------------------------------------------ crypto
inline std::string toHex(const unsigned char *data, size_t len) {
    static const char *digits = "0123456789abcdef";
    std::string out;
    out.reserve(len * 2);
    for (size_t i = 0; i < len; ++i) {
        out.push_back(digits[data[i] >> 4]);
        out.push_back(digits[data[i] & 0x0f]);
    }
    return out;
}

/** HMAC-SHA256 as lowercase hex, the format Razorpay uses for checkout and webhook signatures. */
inline std::string hmacSha256Hex(const std::string &key, std::string_view message) {
    unsigned char out[EVP_MAX_MD_SIZE];
    unsigned int len = 0;
    HMAC(EVP_sha256(), key.data(), static_cast<int>(key.size()), reinterpret_cast<const unsigned char *>(message.data()),
         message.size(), out, &len);
    return toHex(out, len);
}

inline std::string sha256Hex(std::string_view message) {
    unsigned char out[SHA256_DIGEST_LENGTH];
    SHA256(reinterpret_cast<const unsigned char *>(message.data()), message.size(), out);
    return toHex(out, SHA256_DIGEST_LENGTH);
}

/** Constant-time comparison for secrets and signatures (length is not secret). */
inline bool constantTimeEquals(std::string_view a, std::string_view b) {
    return a.size() == b.size() && CRYPTO_memcmp(a.data(), b.data(), a.size()) == 0;
}

inline std::string base64UrlDecode(std::string s) {
    for (auto &c : s) {
        if (c == '-') c = '+';
        else if (c == '_') c = '/';
    }
    while (s.size() % 4 != 0) s.push_back('=');
    return drogon::utils::base64Decode(s);
}

// ------------------------------------------------------------------ env
inline std::string envOr(const char *key, const std::string &fallback = "") {
    const char *v = std::getenv(key);
    return (v != nullptr && *v != '\0') ? std::string(v) : fallback;
}

inline std::string requireEnv(const char *key) {
    std::string v = envOr(key);
    if (v.empty()) {
        std::cerr << "{\"level\":\"FATAL\",\"service\":\"payment-service\",\"msg\":\"missing required env " << key << "\"}" << std::endl;
        std::exit(1);
    }
    return v;
}

// ------------------------------------------------------------------ errors
/** A failure with a safe client-facing code and message. Nothing internal (SQL, stack, secrets) goes in here. */
struct ApiError : std::exception {
    int status;
    std::string code;
    std::string message;
    Json::Value details;
    ApiError(int s, std::string c, std::string m, Json::Value d = Json::Value())
        : status(s), code(std::move(c)), message(std::move(m)), details(std::move(d)) {}
    const char *what() const noexcept override { return message.c_str(); }
};

// ------------------------------------------------------------------ json + logging
inline std::string toJsonString(const Json::Value &v) {
    Json::StreamWriterBuilder b;
    b["indentation"] = "";
    return Json::writeString(b, v);
}

inline Json::Value parseJson(const std::string &text) {
    Json::Value out;
    Json::CharReaderBuilder b;
    std::string errs;
    std::unique_ptr<Json::CharReader> reader(b.newCharReader());
    if (!reader->parse(text.data(), text.data() + text.size(), &out, &errs)) return Json::Value();
    return out;
}

inline void logJson(const char *level, const std::string &msg, Json::Value fields = Json::Value(Json::objectValue)) {
    static std::mutex m;
    Json::Value line(Json::objectValue);
    line["ts"] = trantor::Date::now().toCustomFormattedString("%Y-%m-%dT%H:%M:%S", false) + "Z";
    line["level"] = level;
    line["service"] = "payment-service";
    line["msg"] = msg;
    for (const auto &k : fields.getMemberNames()) line[k] = fields[k];
    std::lock_guard<std::mutex> lock(m);
    std::cout << toJsonString(line) << std::endl;
}

inline Json::Value errorBody(const std::string &code, const std::string &message, const std::string &requestId, const Json::Value &details = Json::Value()) {
    Json::Value err(Json::objectValue);
    err["code"] = code;
    err["message"] = message;
    if (!details.isNull()) err["details"] = details;
    err["requestId"] = requestId;
    Json::Value root(Json::objectValue);
    root["error"] = err;
    return root;
}

}  // namespace pay
