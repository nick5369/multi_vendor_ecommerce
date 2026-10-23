package main

import (
	"log"
	"os"
	"strconv"
)

type Config struct {
	Port             string
	MySQLDSN         string
	JWKSURL          string
	Issuer           string
	Audience         string
	CatalogURL       string
	InternalToken    string
	CartMaxQuantity  int
	InventoryURL          string
	PaymentURL            string
	RabbitURL             string
	ReservationTTLSeconds int
	ShippingFlatPaise     int64
	TaxBps                int
}

func mustEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		log.Fatalf("missing required env %s", key)
	}
	return v
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func loadConfig() Config {
	max, err := strconv.Atoi(envOr("CART_MAX_QUANTITY", "1000"))
	if err != nil || max < 1 {
		log.Fatalf("CART_MAX_QUANTITY must be a positive integer")
	}
	return Config{
		Port:            envOr("PORT", "8083"),
		MySQLDSN:        mustEnv("MYSQL_DSN"),
		JWKSURL:         mustEnv("JWKS_URL"),
		Issuer:          envOr("JWT_ISSUER", "mve-auth"),
		Audience:        envOr("JWT_AUDIENCE", "mve-api"),
		CatalogURL:      envOr("CATALOG_URL", "http://catalog-service:8082"),
		InternalToken:   mustEnv("INTERNAL_SERVICE_TOKEN"),
		CartMaxQuantity: max,
		InventoryURL:          envOr("INVENTORY_URL", "http://inventory-service:8084"),
		PaymentURL:            envOr("PAYMENT_URL", "http://payment-service:8085"),
		RabbitURL:             mustEnv("RABBITMQ_URL"),
		ReservationTTLSeconds: atoiOr("RESERVATION_TTL_SECONDS", 900),
		ShippingFlatPaise:     int64(atoiOr("SHIPPING_FLAT_PAISE", 4900)),
		TaxBps:                atoiOr("TAX_BPS", 0),
	}
}

func atoiOr(key string, fallback int) int {
	v, err := strconv.Atoi(envOr(key, strconv.Itoa(fallback)))
	if err != nil || v < 0 {
		log.Fatalf("%s must be a non-negative integer", key)
	}
	return v
}
