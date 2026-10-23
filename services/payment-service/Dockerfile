FROM ubuntu:24.04 AS build
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake git ca-certificates pkg-config \
    libjsoncpp-dev uuid-dev zlib1g-dev libssl-dev libpq-dev libbrotli-dev \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch v1.9.8 --recurse-submodules --shallow-submodules \
      https://github.com/drogonframework/drogon.git /drogon \
 && cmake -S /drogon -B /drogon/build -DCMAKE_BUILD_TYPE=Release -DBUILD_EXAMPLES=OFF -DBUILD_CTL=OFF \
      -DBUILD_POSTGRESQL=ON -DBUILD_MYSQL=OFF -DBUILD_SQLITE=OFF -DBUILD_REDIS=OFF \
 && cmake --build /drogon/build -j"$(nproc)" && cmake --install /drogon/build
WORKDIR /src
COPY CMakeLists.txt .
COPY src ./src
RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j"$(nproc)"

FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    libjsoncpp25 libuuid1 zlib1g libssl3t64 libpq5 libbrotli1 curl postgresql-client ca-certificates \
 && rm -rf /var/lib/apt/lists/* && useradd -r -u 10001 app
COPY --from=build /src/build/payment-service /usr/local/bin/payment-service
COPY migrations /migrations
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
RUN mkdir /app && chown app /app
WORKDIR /app
USER app
EXPOSE 8085
ENTRYPOINT ["docker-entrypoint.sh"]
