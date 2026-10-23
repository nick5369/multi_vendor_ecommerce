"""baseline: outbox and inbox tables

Revision ID: 0001
"""
from alembic import op

revision = "0001"
down_revision = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE outbox_events (
            id UUID PRIMARY KEY,
            event_type TEXT NOT NULL,
            routing_key TEXT NOT NULL,
            payload JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            published_at TIMESTAMPTZ
        )""")
    op.execute("CREATE INDEX ix_outbox_unpublished ON outbox_events (created_at) WHERE published_at IS NULL")
    op.execute("""
        CREATE TABLE inbox_events (
            event_id UUID PRIMARY KEY,
            event_type TEXT NOT NULL,
            processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )""")


def downgrade() -> None:
    op.execute("DROP TABLE inbox_events")
    op.execute("DROP TABLE outbox_events")
