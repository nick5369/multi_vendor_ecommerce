import os


def _required(key: str) -> str:
    value = os.environ.get(key)
    if not value:
        raise RuntimeError(f"Missing required env {key}")
    return value


DATABASE_URL = _required("DATABASE_URL")
JWKS_URL = _required("JWKS_URL")
JWT_ISSUER = os.environ.get("JWT_ISSUER", "mve-auth")
JWT_AUDIENCE = os.environ.get("JWT_AUDIENCE", "mve-api")
INTERNAL_SERVICE_TOKEN = _required("INTERNAL_SERVICE_TOKEN")
CATALOG_URL = os.environ.get("CATALOG_URL", "http://catalog-service:8082")
RABBITMQ_URL = _required("RABBITMQ_URL")
RESERVATION_TTL_SECONDS = int(os.environ.get("RESERVATION_TTL_SECONDS", "900"))
MAX_STOCK_PER_SKU = 1_000_000
EVENT_EXCHANGE = "mve.events"
