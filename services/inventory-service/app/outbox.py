import logging
import threading

import json

import pika
from sqlalchemy import text

from . import config
from .db import transaction

log = logging.getLogger("outbox")
_stop = threading.Event()


def _relay_once(channel: pika.adapters.blocking_connection.BlockingChannel) -> int:
    """Publishes up to 50 unpublished rows. Rows are locked with SKIP LOCKED so relays never double-send a row."""
    with transaction() as conn:
        rows = conn.execute(text(
            "SELECT id, routing_key, event_type, payload FROM outbox_events "
            "WHERE published_at IS NULL ORDER BY created_at LIMIT 50 FOR UPDATE SKIP LOCKED")).all()
        for row in rows:
            channel.basic_publish(
                exchange=config.EVENT_EXCHANGE,
                routing_key=row.routing_key,
                body=json.dumps(row.payload).encode(),
                properties=pika.BasicProperties(content_type="application/json", message_id=str(row.id), type=row.event_type),
            )
            conn.execute(text("UPDATE outbox_events SET published_at = now() WHERE id = :id"), {"id": row.id})
        return len(rows)


def run() -> None:
    """Background loop: at-least-once delivery; consumers de-duplicate on eventId."""
    connection = None
    while not _stop.is_set():
        try:
            if connection is None or connection.is_closed:
                connection = pika.BlockingConnection(pika.URLParameters(config.RABBITMQ_URL))
                channel = connection.channel()
                channel.exchange_declare(exchange=config.EVENT_EXCHANGE, exchange_type="topic", durable=True)
            if _relay_once(channel) == 0:
                _stop.wait(1.0)
        except Exception as exc:  # unpublished rows stay in the table and are picked up on the next loop
            log.warning("outbox relay paused: %s", type(exc).__name__)
            connection = None
            _stop.wait(2.0)


def start() -> threading.Thread:
    thread = threading.Thread(target=run, name="outbox-relay", daemon=True)
    thread.start()
    return thread


def stop() -> None:
    _stop.set()
