from contextlib import contextmanager
from typing import Iterator

from sqlalchemy import Connection, create_engine

from . import config

# Sized for bursts of concurrent reservation requests; every request holds one connection per transaction.
engine = create_engine(config.DATABASE_URL, pool_size=20, max_overflow=40, pool_pre_ping=True)


@contextmanager
def transaction() -> Iterator[Connection]:
    """One database transaction: commits on success, rolls back on any exception."""
    with engine.begin() as conn:
        yield conn
