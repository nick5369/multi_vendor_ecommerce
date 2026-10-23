#pragma once
#include <drogon/drogon.h>

#include <map>
#include <string>

#include "Util.h"

namespace pay {

struct HttpResult {
    int status = 0;
    Json::Value json;
    std::string body;
};

/** Splits "http://host:port/some/path" into {"http://host:port", "/some/path"}. */
inline std::pair<std::string, std::string> splitUrl(const std::string &url) {
    auto scheme = url.find("://");
    auto slash = url.find('/', scheme + 3);
    if (slash == std::string::npos) return {url, "/"};
    return {url.substr(0, slash), url.substr(slash)};
}

/** Sends one HTTP request. Transport failures surface as std::runtime_error; HTTP errors are returned as results. */
inline drogon::Task<HttpResult> sendHttp(std::string origin, drogon::HttpMethod method, std::string path,
                                         std::map<std::string, std::string> headers = {},
                                         const Json::Value *body = nullptr,
                                         std::map<std::string, std::string> query = {}) {
    auto client = drogon::HttpClient::newHttpClient(origin);
    auto req = drogon::HttpRequest::newHttpRequest();
    req->setMethod(method);
    req->setPathEncode(false);  // paths such as /api/exchanges/%2F/... are already encoded
    req->setPath(path);
    for (const auto &[k, v] : query) req->setParameter(k, v);
    for (const auto &[k, v] : headers) req->addHeader(k, v);
    if (body != nullptr) {
        req->setContentTypeCode(drogon::CT_APPLICATION_JSON);
        req->setBody(toJsonString(*body));
    }
    drogon::HttpResponsePtr resp;
    try {
        resp = co_await client->sendRequestCoro(req);
    } catch (const std::exception &e) {
        throw std::runtime_error(std::string("transport failure: ") + e.what());
    }
    HttpResult out;
    out.status = static_cast<int>(resp->statusCode());
    out.body = std::string(resp->body());
    out.json = parseJson(out.body);
    co_return out;
}

}  // namespace pay
