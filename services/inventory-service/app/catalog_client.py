from uuid import UUID

import httpx

from . import config
from .errors import ApiError


def lookup_sku_owner(sku_id: UUID) -> UUID | None:
    """Asks the catalog (source of truth for products) which seller owns a SKU. None if the SKU does not exist."""
    try:
        resp = httpx.post(
            f"{config.CATALOG_URL}/internal/skus/lookup",
            json={"ids": [str(sku_id)]},
            headers={"X-Internal-Token": config.INTERNAL_SERVICE_TOKEN},
            timeout=5.0,
        )
        resp.raise_for_status()
    except httpx.HTTPError:
        raise ApiError(503, "CATALOG_UNAVAILABLE", "Could not verify the SKU with the catalog") from None
    rows = resp.json()
    return UUID(rows[0]["sellerId"]) if rows else None
