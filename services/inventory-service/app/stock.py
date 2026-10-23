"""Stock balances, adjustments and reservations. All correctness rests on SQL: conditional UPDATEs,
CHECK constraints, UNIQUE keys and row locks, never on in-process state."""
import hashlib
import json
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import Connection, text

from . import config
from .db import transaction
from .errors import bad_request, conflict, not_found
from .events import audit, emit


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat()


# ------------------------------------------------------------------ seller stock management
def set_stock(seller_id: UUID, sku_id: UUID, on_hand: int, reason: str, actor: UUID) -> dict[str, Any]:
    """Initialise or overwrite on_hand for a SKU the seller owns. Never drops below what is reserved."""
    with transaction() as conn:
        conn.execute(text(
            "INSERT INTO inventory_balances (sku_id, seller_id, on_hand, reserved) VALUES (:s, :seller, 0, 0) "
            "ON CONFLICT (sku_id) DO NOTHING"), {"s": sku_id, "seller": seller_id})
        row = conn.execute(text(
            "SELECT seller_id, on_hand, reserved FROM inventory_balances WHERE sku_id = :s FOR UPDATE"), {"s": sku_id}).one()
        if row.seller_id != seller_id:
            raise not_found("SKU")  # the SKU already belongs to another seller's stock record
        if on_hand < row.reserved:
            raise conflict("BELOW_RESERVED", f"{row.reserved} units are reserved; on_hand cannot go lower")
        _apply_delta(conn, seller_id, sku_id, on_hand - row.on_hand, reason, actor)
        return balance(conn, sku_id)


def adjust_stock(seller_id: UUID, sku_id: UUID, delta: int, reason: str, actor: UUID, idem_key: str | None) -> dict[str, Any]:
    request_hash = hashlib.sha256(json.dumps([str(sku_id), delta, reason], separators=(",", ":")).encode()).hexdigest()
    with transaction() as conn:
        if idem_key:
            claimed = conn.execute(text(
                "INSERT INTO processed_commands (command_key, request_hash, result) VALUES (:k, :h, '{}'::jsonb) "
                "ON CONFLICT (command_key) DO NOTHING RETURNING 1"),
                {"k": f"adjust:{seller_id}:{idem_key}", "h": request_hash}).first()
            if claimed is None:
                existing = conn.execute(text("SELECT request_hash, result FROM processed_commands WHERE command_key = :k"),
                                        {"k": f"adjust:{seller_id}:{idem_key}"}).one()
                if existing.request_hash != request_hash:
                    raise conflict("IDEMPOTENCY_KEY_REUSED", "Idempotency-Key was used with a different request")
                return existing.result
        row = conn.execute(text(
            "SELECT on_hand, reserved FROM inventory_balances WHERE sku_id = :s AND seller_id = :seller FOR UPDATE"),
            {"s": sku_id, "seller": seller_id}).first()
        if row is None:
            raise not_found("Stock record")
        if row.on_hand + delta < row.reserved:
            raise conflict("BELOW_RESERVED", "Adjustment would drop on_hand below reserved units")
        if row.on_hand + delta > config.MAX_STOCK_PER_SKU:
            raise bad_request("on_hand would exceed the allowed maximum")
        _apply_delta(conn, seller_id, sku_id, delta, reason, actor)
        result = balance(conn, sku_id)
        if idem_key:
            conn.execute(text("UPDATE processed_commands SET result = CAST(:r AS jsonb) WHERE command_key = :k"),
                         {"r": json.dumps(result), "k": f"adjust:{seller_id}:{idem_key}"})
        return result


def _apply_delta(conn: Connection, seller_id: UUID, sku_id: UUID, delta: int, reason: str, actor: UUID) -> None:
    after = conn.execute(text(
        "UPDATE inventory_balances SET on_hand = on_hand + :d, updated_at = now() WHERE sku_id = :s RETURNING on_hand"),
        {"d": delta, "s": sku_id}).scalar_one()
    conn.execute(text(
        "INSERT INTO inventory_adjustments (id, sku_id, seller_id, delta, reason, actor_id, on_hand_after) "
        "VALUES (:id, :s, :seller, :d, :r, :actor, :after)"),
        {"id": uuid4(), "s": sku_id, "seller": seller_id, "d": delta, "r": reason, "actor": actor, "after": after})
    audit(conn, "STOCK_ADJUSTED", str(sku_id), str(actor), {"delta": delta, "reason": reason, "onHandAfter": after})


def balance(conn: Connection, sku_id: UUID) -> dict[str, Any]:
    row = conn.execute(text(
        "SELECT sku_id, seller_id, on_hand, reserved, on_hand - reserved AS available, updated_at "
        "FROM inventory_balances WHERE sku_id = :s"), {"s": sku_id}).one()
    return _balance_dict(row)


def _balance_dict(row: Any) -> dict[str, Any]:
    return {"skuId": str(row.sku_id), "sellerId": str(row.seller_id), "onHand": row.on_hand,
            "reserved": row.reserved, "available": row.available, "updatedAt": _iso(row.updated_at)}


def list_seller_stock(seller_id: UUID, page: int, size: int) -> dict[str, Any]:
    with transaction() as conn:
        rows = conn.execute(text(
            "SELECT sku_id, seller_id, on_hand, reserved, on_hand - reserved AS available, updated_at FROM inventory_balances "
            "WHERE seller_id = :s ORDER BY updated_at DESC, sku_id LIMIT :l OFFSET :o"),
            {"s": seller_id, "l": size, "o": page * size}).all()
        total = conn.execute(text("SELECT count(*) FROM inventory_balances WHERE seller_id = :s"), {"s": seller_id}).scalar_one()
    return {"items": [_balance_dict(r) for r in rows], "page": page, "size": size, "total": total}


def availability_hints(sku_ids: list[UUID]) -> list[dict[str, Any]]:
    """Non-authoritative hint for the UI. The real check happens atomically inside reserve()."""
    with transaction() as conn:
        rows = conn.execute(text(
            "SELECT sku_id, on_hand - reserved AS available FROM inventory_balances WHERE sku_id = ANY(:ids)"),
            {"ids": sku_ids}).all()
    found = {r.sku_id: r.available for r in rows}
    return [{"skuId": str(s), "available": found.get(s, 0)} for s in sku_ids]


# ------------------------------------------------------------------ reservations
def _normalise(items: list[tuple[UUID, int]]) -> list[tuple[UUID, int]]:
    skus = [s for s, _ in items]
    if len(set(skus)) != len(skus):
        raise bad_request("Duplicate skuId in items")
    # deterministic lock order: concurrent multi-SKU checkouts always touch rows in the same sequence
    return sorted(items, key=lambda i: str(i[0]))


def reserve(checkout_id: UUID, items: list[tuple[UUID, int]], ttl_seconds: int | None) -> tuple[dict[str, Any], bool]:
    """All-or-nothing reservation for one checkout. Returns (reservation, created).
    Repeating the call for the same checkout returns the stored reservation and changes nothing."""
    ordered = _normalise(items)
    ttl = ttl_seconds or config.RESERVATION_TTL_SECONDS
    failures: list[dict[str, Any]] = []
    try:
        with transaction() as conn:
            reservation_id = uuid4()
            expires = datetime.now(timezone.utc) + timedelta(seconds=ttl)
            inserted = conn.execute(text(
                "INSERT INTO reservations (id, checkout_id, status, expires_at) VALUES (:id, :c, 'RESERVED', :e) "
                "ON CONFLICT (checkout_id) DO NOTHING RETURNING id"), {"id": reservation_id, "c": checkout_id, "e": expires}).first()
            if inserted is None:
                existing = _load(conn, checkout_id)
                if _items_of(existing) != {str(s): q for s, q in ordered}:
                    raise conflict("CHECKOUT_PAYLOAD_MISMATCH", "This checkout already has a reservation for different items")
                return existing, False
            for sku_id, qty in ordered:
                updated = conn.execute(text(
                    "UPDATE inventory_balances SET reserved = reserved + :q, updated_at = now() "
                    "WHERE sku_id = :s AND on_hand - reserved >= :q RETURNING seller_id"), {"q": qty, "s": sku_id}).first()
                if updated is None:
                    avail = conn.execute(text("SELECT on_hand - reserved FROM inventory_balances WHERE sku_id = :s"),
                                         {"s": sku_id}).scalar()
                    failures.append({"skuId": str(sku_id), "requested": qty, "available": avail or 0})
                    continue
                conn.execute(text(
                    "INSERT INTO reservation_items (reservation_id, sku_id, seller_id, quantity) VALUES (:r, :s, :seller, :q)"),
                    {"r": reservation_id, "s": sku_id, "seller": updated.seller_id, "q": qty})
            if failures:
                raise _InsufficientStock()  # rolls back the reservation row and every increment above
            result = _load(conn, checkout_id)
            emit(conn, "StockReserved", "stock.reserved.v1", result)
            audit(conn, "RESERVED", str(checkout_id), "order-service", {"items": result["items"]})
            return result, True
    except _InsufficientStock:
        with transaction() as conn:
            emit(conn, "ReservationFailed", "stock.reservation-failed.v1", {"checkoutId": str(checkout_id), "failures": failures})
            audit(conn, "RESERVATION_FAILED", str(checkout_id), "order-service", {"failures": failures})
        raise conflict("INSUFFICIENT_STOCK", "Not enough stock for one or more items", failures) from None


class _InsufficientStock(Exception):
    pass


def release(checkout_id: UUID) -> dict[str, Any]:
    """RESERVED -> RELEASED exactly once; repeating is a no-op. A committed sale cannot be released."""
    with transaction() as conn:
        row = _lock(conn, checkout_id)
        if row.status == "RELEASED":
            return _load(conn, checkout_id)
        if row.status == "COMMITTED":
            raise conflict("ALREADY_COMMITTED", "Reservation was already committed")
        for sku_id, qty in _locked_items(conn, row.id):
            conn.execute(text("UPDATE inventory_balances SET reserved = reserved - :q, updated_at = now() WHERE sku_id = :s"),
                         {"q": qty, "s": sku_id})
        conn.execute(text("UPDATE reservations SET status = 'RELEASED', updated_at = now() WHERE id = :id"), {"id": row.id})
        result = _load(conn, checkout_id)
        emit(conn, "StockReleased", "stock.released.v1", result)
        audit(conn, "RELEASED", str(checkout_id), "order-service", {})
        return result


def commit(checkout_id: UUID) -> dict[str, Any]:
    """RESERVED -> COMMITTED exactly once (on_hand and reserved both drop); repeating is a no-op."""
    with transaction() as conn:
        row = _lock(conn, checkout_id)
        if row.status == "COMMITTED":
            return _load(conn, checkout_id)
        if row.status == "RELEASED":
            raise conflict("ALREADY_RELEASED", "Reservation was already released")
        for sku_id, qty in _locked_items(conn, row.id):
            conn.execute(text(
                "UPDATE inventory_balances SET on_hand = on_hand - :q, reserved = reserved - :q, updated_at = now() WHERE sku_id = :s"),
                {"q": qty, "s": sku_id})
        conn.execute(text("UPDATE reservations SET status = 'COMMITTED', updated_at = now() WHERE id = :id"), {"id": row.id})
        audit(conn, "COMMITTED", str(checkout_id), "order-service", {})
        return _load(conn, checkout_id)


def get_reservation(checkout_id: UUID) -> dict[str, Any]:
    with transaction() as conn:
        return _load(conn, checkout_id)


def list_expired(limit: int = 100) -> list[dict[str, Any]]:
    """Reservations past their expiry that are still RESERVED. Inventory never releases these by itself:
    the order service decides after checking whether a payment may still complete."""
    with transaction() as conn:
        ids = conn.execute(text(
            "SELECT checkout_id FROM reservations WHERE status = 'RESERVED' AND expires_at < now() "
            "ORDER BY expires_at LIMIT :l"), {"l": limit}).scalars().all()
        return [_load(conn, c) for c in ids]


def list_reservations(status: str | None, page: int, size: int) -> dict[str, Any]:
    with transaction() as conn:
        where = "WHERE status = :st" if status else ""
        params: dict[str, Any] = {"st": status, "l": size, "o": page * size}
        ids = conn.execute(text(f"SELECT checkout_id FROM reservations {where} ORDER BY created_at DESC LIMIT :l OFFSET :o"), params).scalars().all()
        total = conn.execute(text(f"SELECT count(*) FROM reservations {where}"), params).scalar_one()
        return {"items": [_load(conn, c) for c in ids], "page": page, "size": size, "total": total}


# ------------------------------------------------------------------ helpers
def _lock(conn: Connection, checkout_id: UUID) -> Any:
    row = conn.execute(text("SELECT id, status FROM reservations WHERE checkout_id = :c FOR UPDATE"), {"c": checkout_id}).first()
    if row is None:
        raise not_found("Reservation")
    return row


def _locked_items(conn: Connection, reservation_id: UUID) -> list[tuple[UUID, int]]:
    rows = conn.execute(text("SELECT sku_id, quantity FROM reservation_items WHERE reservation_id = :r ORDER BY sku_id::text"),
                        {"r": reservation_id}).all()
    return [(r.sku_id, r.quantity) for r in rows]


def _load(conn: Connection, checkout_id: UUID) -> dict[str, Any]:
    head = conn.execute(text("SELECT id, checkout_id, status, expires_at FROM reservations WHERE checkout_id = :c"),
                        {"c": checkout_id}).first()
    if head is None:
        raise not_found("Reservation")
    items = conn.execute(text(
        "SELECT sku_id, seller_id, quantity FROM reservation_items WHERE reservation_id = :r ORDER BY sku_id::text"),
        {"r": head.id}).all()
    return {"reservationId": str(head.id), "checkoutId": str(head.checkout_id), "status": head.status,
            "expiresAt": _iso(head.expires_at),
            "items": [{"skuId": str(i.sku_id), "sellerId": str(i.seller_id), "quantity": i.quantity} for i in items]}


def _items_of(reservation: dict[str, Any]) -> dict[str, int]:
    return {i["skuId"]: i["quantity"] for i in reservation["items"]}


