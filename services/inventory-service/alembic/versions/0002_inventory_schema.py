"""inventory balances, reservations, adjustments, audit, processed commands

Revision ID: 0002
Revises: 0001
"""
from alembic import op

revision = "0002"
down_revision = "0001"


def upgrade() -> None:
    op.execute("""
        CREATE TABLE inventory_balances (
            sku_id     UUID PRIMARY KEY,
            seller_id  UUID        NOT NULL,
            on_hand    INTEGER     NOT NULL DEFAULT 0,
            reserved   INTEGER     NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT ck_on_hand_non_negative CHECK (on_hand >= 0),
            CONSTRAINT ck_reserved_non_negative CHECK (reserved >= 0),
            CONSTRAINT ck_reserved_within_on_hand CHECK (reserved <= on_hand)
        )""")
    op.execute("CREATE INDEX ix_balances_seller ON inventory_balances (seller_id)")

    op.execute("""
        CREATE TABLE reservations (
            id          UUID PRIMARY KEY,
            checkout_id UUID        NOT NULL,
            status      TEXT        NOT NULL CHECK (status IN ('RESERVED', 'RELEASED', 'COMMITTED')),
            expires_at  TIMESTAMPTZ NOT NULL,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT uq_reservation_checkout UNIQUE (checkout_id)
        )""")
    op.execute("CREATE INDEX ix_reservations_due ON reservations (expires_at) WHERE status = 'RESERVED'")

    op.execute("""
        CREATE TABLE reservation_items (
            reservation_id UUID    NOT NULL REFERENCES reservations (id),
            sku_id         UUID    NOT NULL,
            seller_id      UUID    NOT NULL,
            quantity       INTEGER NOT NULL CHECK (quantity > 0),
            PRIMARY KEY (reservation_id, sku_id)
        )""")

    op.execute("""
        CREATE TABLE inventory_adjustments (
            id            UUID PRIMARY KEY,
            sku_id        UUID        NOT NULL,
            seller_id     UUID        NOT NULL,
            delta         INTEGER     NOT NULL,
            reason        TEXT        NOT NULL,
            actor_id      UUID        NOT NULL,
            on_hand_after INTEGER     NOT NULL,
            created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        )""")
    op.execute("CREATE INDEX ix_adjustments_sku ON inventory_adjustments (sku_id, created_at DESC)")

    op.execute("""
        CREATE TABLE inventory_audit_log (
            id         BIGSERIAL PRIMARY KEY,
            action     TEXT        NOT NULL,
            ref_id     TEXT        NOT NULL,
            actor      TEXT        NOT NULL,
            details    JSONB       NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )""")
    op.execute("CREATE INDEX ix_audit_ref ON inventory_audit_log (ref_id)")

    op.execute("""
        CREATE TABLE processed_commands (
            command_key  TEXT PRIMARY KEY,
            request_hash TEXT        NOT NULL,
            result       JSONB       NOT NULL,
            created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
        )""")


def downgrade() -> None:
    for table in ("processed_commands", "inventory_audit_log", "inventory_adjustments",
                  "reservation_items", "reservations", "inventory_balances"):
        op.execute(f"DROP TABLE {table}")
