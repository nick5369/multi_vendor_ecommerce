#!/usr/bin/env bash
# Logical backups of every durable database into infrastructure/backups/<UTC timestamp>/ (gitignored).
# Needs the stack running. Redis (disposable cache) and RabbitMQ (in-flight messages; events are re-published from
# the services' outbox tables) are intentionally not backed up. Backups contain real data: treat them as secrets.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
dc() { docker compose "$@"; }
TS=$(date -u +%Y%m%dT%H%M%SZ)
DIR="infrastructure/backups/$TS"
mkdir -p "$DIR"

for spec in "catalog-postgres:$CATALOG_DB_USER:$CATALOG_DB" "inventory-postgres:$INVENTORY_DB_USER:$INVENTORY_DB" "payment-postgres:$PAYMENT_DB_USER:$PAYMENT_DB"; do
  IFS=: read -r svc user db <<<"$spec"
  dc exec -T "$svc" pg_dump -U "$user" -d "$db" --format=custom --no-owner > "$DIR/$svc.dump"
  echo "postgres $svc ok ($(wc -c < "$DIR/$svc.dump") bytes)"
done

dc exec -T -e MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql mysqldump -uroot --single-transaction --routines --triggers "$MYSQL_DB" > "$DIR/mysql.sql"
echo "mysql ok ($(wc -c < "$DIR/mysql.sql") bytes)"

dc exec -T mongodb mongodump -u "$MONGO_ROOT_USER" -p "$MONGO_ROOT_PASSWORD" --authenticationDatabase admin --db "$MONGO_DB" --archive --gzip > "$DIR/mongodb.archive.gz"
echo "mongodb ok ($(wc -c < "$DIR/mongodb.archive.gz") bytes)"

# an empty or truncated dump is a failed backup
for f in "$DIR"/*; do [ -s "$f" ] || { echo "EMPTY BACKUP FILE: $f" >&2; exit 1; }; done
(cd "$DIR" && sha256sum * > SHA256SUMS)
echo "backup complete: $DIR"
