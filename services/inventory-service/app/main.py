import logging
import re
import time
import uuid
from contextlib import asynccontextmanager
from typing import Annotated
from uuid import UUID

from fastapi import Depends, FastAPI, Header, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from . import catalog_client, config, logging_setup, outbox, stock
from .db import engine, transaction
from .errors import ApiError, not_found
from .security import Principal, require_admin, require_internal, require_seller

logging_setup.configure()
access_log = logging.getLogger("access")
_SAFE_ID = re.compile(r"^[\w-]{8,64}$")


@asynccontextmanager
async def lifespan(_: FastAPI):
    outbox.start()
    yield
    outbox.stop()


app = FastAPI(title="Inventory Service", version="0.2.0", lifespan=lifespan)


# ------------------------------------------------------------------ cross-cutting
@app.middleware("http")
async def request_context(request: Request, call_next):
    incoming = request.headers.get("x-request-id", "")
    request_id = incoming if _SAFE_ID.match(incoming) else str(uuid.uuid4())
    logging_setup.request_id_var.set(request_id)
    started = time.perf_counter()
    response = await call_next(request)
    response.headers["X-Request-Id"] = request_id
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Cache-Control"] = "no-store"
    if request.url.path not in ("/health", "/metrics"):
        access_log.info("request", extra={"fields": {
            "method": request.method, "path": request.url.path, "status": response.status_code,
            "durationMs": round((time.perf_counter() - started) * 1000, 2)}})
    return response


def _error(status: int, code: str, message: str, details=None) -> JSONResponse:
    body = {"code": code, "message": message, "requestId": logging_setup.request_id_var.get()}
    if details is not None:
        body["details"] = details
    return JSONResponse({"error": body}, status_code=status)


@app.exception_handler(ApiError)
async def api_error_handler(_: Request, exc: ApiError) -> JSONResponse:
    return _error(exc.status, exc.code, exc.message, exc.details)


@app.exception_handler(RequestValidationError)
async def validation_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
    details = [f"{'.'.join(str(p) for p in e['loc'][1:])}: {e['msg']}" for e in exc.errors()]
    return _error(400, "VALIDATION_ERROR", "Validation failed", details)


@app.exception_handler(IntegrityError)
async def integrity_handler(_: Request, exc: IntegrityError) -> JSONResponse:
    return _error(409, "CONFLICT", "Request conflicts with current stock state")


@app.exception_handler(Exception)
async def unhandled_handler(_: Request, exc: Exception) -> JSONResponse:
    logging.getLogger("app").error("unhandled error type=%s", type(exc).__name__)
    return _error(500, "INTERNAL_ERROR", "Unexpected error")


# ------------------------------------------------------------------ schemas
class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SetStockRequest(Strict):
    onHand: int = Field(ge=0, le=config.MAX_STOCK_PER_SKU)
    reason: str = Field(default="initial stock", min_length=1, max_length=200)


class AdjustRequest(Strict):
    delta: int = Field(ge=-config.MAX_STOCK_PER_SKU, le=config.MAX_STOCK_PER_SKU)
    reason: str = Field(min_length=1, max_length=200)


class ItemIn(Strict):
    skuId: UUID
    quantity: int = Field(ge=1, le=10000)


class ReserveRequest(Strict):
    checkoutId: UUID
    items: list[ItemIn] = Field(min_length=1, max_length=50)
    ttlSeconds: int | None = Field(default=None, ge=30, le=86400)


Seller = Annotated[Principal, Depends(require_seller)]
Admin = Annotated[Principal, Depends(require_admin)]
Page = Annotated[int, Query(ge=0)]
Size = Annotated[int, Query(ge=1, le=100)]


# ------------------------------------------------------------------ ops
@app.get("/health")
def health() -> JSONResponse:
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
    except Exception:
        return JSONResponse({"status": "DOWN", "service": "inventory-service", "db": "down"}, status_code=503)
    return JSONResponse({"status": "UP", "service": "inventory-service", "db": "up"})


@app.get("/metrics")
def metrics() -> Response:
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)


# ------------------------------------------------------------------ public hint
@app.get("/stock")
def stock_hints(skuIds: Annotated[str, Query(min_length=36, max_length=4000)]):
    """Non-authoritative availability hint (comma separated SKU ids, max 100)."""
    try:
        ids = [UUID(s) for s in skuIds.split(",")]
    except ValueError:
        raise ApiError(400, "VALIDATION_ERROR", "skuIds must be comma separated UUIDs") from None
    if len(ids) > 100:
        raise ApiError(400, "VALIDATION_ERROR", "At most 100 skuIds")
    return stock.availability_hints(ids)


# ------------------------------------------------------------------ seller
def _own_sku(seller: Principal, sku_id: UUID) -> None:
    """The catalog is the source of truth for who owns a SKU. Others' SKUs look like they do not exist."""
    owner = catalog_client.lookup_sku_owner(sku_id)
    if owner is None or owner != seller.store_id:
        raise not_found("SKU")


@app.put("/seller/stock/{sku_id}")
def seller_set_stock(sku_id: UUID, body: SetStockRequest, seller: Seller):
    _own_sku(seller, sku_id)
    return stock.set_stock(seller.store_id, sku_id, body.onHand, body.reason, seller.user_id)


@app.post("/seller/stock/{sku_id}/adjust")
def seller_adjust(sku_id: UUID, body: AdjustRequest, seller: Seller,
                  idempotency_key: Annotated[str | None, Header(max_length=100)] = None):
    _own_sku(seller, sku_id)
    return stock.adjust_stock(seller.store_id, sku_id, body.delta, body.reason, seller.user_id, idempotency_key)


@app.get("/seller/stock")
def seller_list(seller: Seller, page: Page = 0, size: Size = 20):
    return stock.list_seller_stock(seller.store_id, page, size)


# ------------------------------------------------------------------ admin (read-only audit views)
@app.get("/admin/adjustments")
def admin_adjustments(_: Admin, page: Page = 0, size: Size = 20):
    with transaction() as conn:
        rows = conn.execute(text(
            "SELECT id, sku_id, seller_id, delta, reason, actor_id, on_hand_after, created_at FROM inventory_adjustments "
            "ORDER BY created_at DESC LIMIT :l OFFSET :o"), {"l": size, "o": page * size}).all()
        total = conn.execute(text("SELECT count(*) FROM inventory_adjustments")).scalar_one()
    items = [{"id": str(r.id), "skuId": str(r.sku_id), "sellerId": str(r.seller_id), "delta": r.delta, "reason": r.reason,
              "actorId": str(r.actor_id), "onHandAfter": r.on_hand_after, "createdAt": r.created_at.isoformat()} for r in rows]
    return {"items": items, "page": page, "size": size, "total": total}


@app.get("/admin/reservations")
def admin_reservations(_: Admin, status: Annotated[str | None, Query(pattern="^(RESERVED|RELEASED|COMMITTED)$")] = None,
                       page: Page = 0, size: Size = 20):
    return stock.list_reservations(status, page, size)


# ------------------------------------------------------------------ internal (order-service only; blocked at the gateway)
@app.post("/internal/reservations", dependencies=[Depends(require_internal)])
def internal_reserve(body: ReserveRequest, response: Response):
    reservation, created = stock.reserve(body.checkoutId, [(i.skuId, i.quantity) for i in body.items], body.ttlSeconds)
    response.status_code = 201 if created else 200
    return reservation


@app.get("/internal/reservations/expired", dependencies=[Depends(require_internal)])
def internal_expired():
    return stock.list_expired()


@app.get("/internal/reservations/{checkout_id}", dependencies=[Depends(require_internal)])
def internal_get(checkout_id: UUID):
    return stock.get_reservation(checkout_id)


@app.post("/internal/reservations/{checkout_id}/release", dependencies=[Depends(require_internal)])
def internal_release(checkout_id: UUID):
    return stock.release(checkout_id)


@app.post("/internal/reservations/{checkout_id}/commit", dependencies=[Depends(require_internal)])
def internal_commit(checkout_id: UUID):
    return stock.commit(checkout_id)
