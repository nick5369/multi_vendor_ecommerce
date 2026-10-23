import json
from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import Connection, text


def emit(conn: Connection, event_type: str, routing_key: str, data: dict) -> None:
    """Writes an event to the outbox inside the caller's transaction. The relay publishes it later."""
    event_id = str(uuid4())
    envelope = {
        "eventId": event_id,
        "eventType": event_type,
        "version": 1,
        "occurredAt": datetime.now(timezone.utc).isoformat(),
        "data": data,
    }
    conn.execute(
        text("INSERT INTO outbox_events (id, event_type, routing_key, payload) VALUES (:id, :t, :rk, CAST(:p AS jsonb))"),
        {"id": event_id, "t": event_type, "rk": routing_key, "p": json.dumps(envelope)},
    )


def audit(conn: Connection, action: str, ref_id: str, actor: str, details: dict) -> None:
    conn.execute(
        text("INSERT INTO inventory_audit_log (action, ref_id, actor, details) VALUES (:a, :r, :actor, CAST(:d AS jsonb))"),
        {"a": action, "r": ref_id, "actor": actor, "d": json.dumps(details)},
    )
