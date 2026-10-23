#pragma once
#include <openssl/bn.h>
#include <openssl/core_names.h>
#include <openssl/evp.h>
#include <openssl/param_build.h>

#include <algorithm>
#include <ctime>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <vector>

#include "Config.h"
#include "Http.h"
#include "Util.h"

namespace pay {

struct Principal {
    std::string userId;
    std::vector<std::string> roles;
    std::string storeId;
    bool has(const std::string &role) const { return std::find(roles.begin(), roles.end(), role) != roles.end(); }
};

/** Verifies RS256 access tokens issued by auth-service, using its published JWKS. Checks signature, iss, aud, exp. */
class JwtVerifier {
  public:
    explicit JwtVerifier(const Config &cfg) : cfg_(cfg) {
        auto [origin, path] = splitUrl(cfg.jwksUrl);
        origin_ = origin;
        path_ = path;
    }

    drogon::Task<std::optional<Principal>> verify(std::string token) {
        auto parts = split(token);
        if (parts.size() != 3) co_return std::nullopt;
        Json::Value header = parseJson(drogon::utils::base64Decode(pad(parts[0])));
        if (header["alg"].asString() != "RS256") co_return std::nullopt;
        std::string kid = header["kid"].asString();

        std::shared_ptr<EVP_PKEY> key = find(kid);
        if (!key) {
            co_await refresh();
            key = find(kid);
        }
        if (!key) co_return std::nullopt;

        std::string signature = base64UrlDecode(parts[2]);
        std::string signedPart = parts[0] + "." + parts[1];
        if (!rsaVerify(key.get(), signedPart, signature)) co_return std::nullopt;

        Json::Value claims = parseJson(base64UrlDecode(parts[1]));
        if (claims.isNull() || !claims.isObject()) co_return std::nullopt;
        if (claims["iss"].asString() != cfg_.jwtIssuer) co_return std::nullopt;
        if (!audienceMatches(claims["aud"])) co_return std::nullopt;
        if (!claims["exp"].isNumeric() || claims["exp"].asInt64() <= static_cast<int64_t>(std::time(nullptr))) co_return std::nullopt;
        if (!claims["sub"].isString() || claims["roles"].isNull() || !claims["roles"].isArray()) co_return std::nullopt;

        Principal p;
        p.userId = claims["sub"].asString();
        for (const auto &r : claims["roles"]) p.roles.push_back(r.asString());
        p.storeId = claims["storeId"].isString() ? claims["storeId"].asString() : "";
        co_return p;
    }

  private:
    Config cfg_;
    std::string origin_, path_;
    std::mutex mutex_;
    std::map<std::string, std::shared_ptr<EVP_PKEY>> keys_;
    std::chrono::steady_clock::time_point lastRefresh_{};

    static std::vector<std::string> split(const std::string &s) {
        std::vector<std::string> out;
        size_t start = 0;
        while (true) {
            auto dot = s.find('.', start);
            if (dot == std::string::npos) {
                out.push_back(s.substr(start));
                break;
            }
            out.push_back(s.substr(start, dot - start));
            start = dot + 1;
        }
        return out;
    }

    static std::string pad(std::string s) {
        for (auto &c : s) {
            if (c == '-') c = '+';
            else if (c == '_') c = '/';
        }
        while (s.size() % 4 != 0) s.push_back('=');
        return s;
    }

    bool audienceMatches(const Json::Value &aud) const {
        if (aud.isString()) return aud.asString() == cfg_.jwtAudience;
        if (aud.isArray()) {
            for (const auto &a : aud)
                if (a.asString() == cfg_.jwtAudience) return true;
        }
        return false;
    }

    std::shared_ptr<EVP_PKEY> find(const std::string &kid) {
        std::lock_guard<std::mutex> lock(mutex_);
        auto it = keys_.find(kid);
        return it == keys_.end() ? nullptr : it->second;
    }

    drogon::Task<void> refresh() {
        {
            // an unknown key id triggers at most one fetch per 10 seconds
            std::lock_guard<std::mutex> lock(mutex_);
            if (!keys_.empty() && std::chrono::steady_clock::now() - lastRefresh_ < std::chrono::seconds(10)) co_return;
        }
        HttpResult res;
        try {
            res = co_await sendHttp(origin_, drogon::Get, path_);
        } catch (const std::exception &) {
            co_return;
        }
        if (res.status != 200) co_return;
        std::map<std::string, std::shared_ptr<EVP_PKEY>> fresh;
        for (const auto &k : res.json["keys"]) {
            if (k["kty"].asString() != "RSA") continue;
            auto key = makeKey(base64UrlDecode(k["n"].asString()), base64UrlDecode(k["e"].asString()));
            if (key) fresh[k["kid"].asString()] = key;
        }
        std::lock_guard<std::mutex> lock(mutex_);
        keys_ = std::move(fresh);
        lastRefresh_ = std::chrono::steady_clock::now();
    }

    static std::shared_ptr<EVP_PKEY> makeKey(const std::string &n, const std::string &e) {
        BIGNUM *bn = BN_bin2bn(reinterpret_cast<const unsigned char *>(n.data()), static_cast<int>(n.size()), nullptr);
        BIGNUM *be = BN_bin2bn(reinterpret_cast<const unsigned char *>(e.data()), static_cast<int>(e.size()), nullptr);
        OSSL_PARAM_BLD *bld = OSSL_PARAM_BLD_new();
        EVP_PKEY *pkey = nullptr;
        if (bn && be && bld && OSSL_PARAM_BLD_push_BN(bld, OSSL_PKEY_PARAM_RSA_N, bn) && OSSL_PARAM_BLD_push_BN(bld, OSSL_PKEY_PARAM_RSA_E, be)) {
            OSSL_PARAM *params = OSSL_PARAM_BLD_to_param(bld);
            EVP_PKEY_CTX *ctx = EVP_PKEY_CTX_new_from_name(nullptr, "RSA", nullptr);
            if (params && ctx && EVP_PKEY_fromdata_init(ctx) > 0) EVP_PKEY_fromdata(ctx, &pkey, EVP_PKEY_PUBLIC_KEY, params);
            EVP_PKEY_CTX_free(ctx);
            OSSL_PARAM_free(params);
        }
        OSSL_PARAM_BLD_free(bld);
        BN_free(bn);
        BN_free(be);
        return pkey ? std::shared_ptr<EVP_PKEY>(pkey, EVP_PKEY_free) : nullptr;
    }

    static bool rsaVerify(EVP_PKEY *key, const std::string &message, const std::string &signature) {
        EVP_MD_CTX *ctx = EVP_MD_CTX_new();
        bool ok = ctx && EVP_DigestVerifyInit(ctx, nullptr, EVP_sha256(), nullptr, key) == 1 &&
                  EVP_DigestVerify(ctx, reinterpret_cast<const unsigned char *>(signature.data()), signature.size(),
                                   reinterpret_cast<const unsigned char *>(message.data()), message.size()) == 1;
        EVP_MD_CTX_free(ctx);
        return ok;
    }
};

}  // namespace pay
