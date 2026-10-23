FROM golang:1.23.2-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY . .
RUN go mod tidy && CGO_ENABLED=0 go build -o /out/order-service .

FROM alpine:3.20
RUN apk add --no-cache curl && adduser -D -u 10001 app
COPY --from=build /out/order-service /usr/local/bin/order-service
USER app
EXPOSE 8083
CMD ["order-service"]
