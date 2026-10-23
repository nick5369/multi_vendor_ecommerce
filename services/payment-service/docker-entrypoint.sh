#!/bin/sh
# Applies /migrations/*.sql in filename order, each exactly once (tracked in schema_migrations), then starts the app.
set -eu
export PGPASSWORD="$DB_PASSWORD"
PSQL="psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -v ON_ERROR_STOP=1 -q"
$PSQL -c "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"
for f in /migrations/*.sql; do
  v=$(basename "$f")
  if [ "$($PSQL -tAc "SELECT 1 FROM schema_migrations WHERE version='$v'")" != "1" ]; then
    echo "applying migration $v"
    # single transaction: schema change and its bookkeeping row commit together
    $PSQL --single-transaction -f "$f" -c "INSERT INTO schema_migrations(version) VALUES ('$v')"
  fi
done
exec payment-service
