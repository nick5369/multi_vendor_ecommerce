#!/usr/bin/env bash
# Non-destructive durability checks.
#  1. row counts survive `docker compose down` + `up -d` (named volumes; this script NEVER uses -v)
#  2. a fresh backup restores into SCRATCH databases with identical counts (live data is not touched)
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
dc() { docker compose "$@"; }
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

pg() { dc exec -T "$1" psql -U "$2" -d "$3" -Atc "$4"; }
my() { dc exec -T -e MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql mysql -uroot -N -e "$1" ${2:-}; }
mongo() { dc exec -T mongodb mongosh --quiet -u "$MONGO_ROOT_USER" -p "$MONGO_ROOT_PASSWORD" --authenticationDatabase admin "$1" --eval "$2"; }

counts() {
  echo "catalog.products=$(pg catalog-postgres "$CATALOG_DB_USER" "$CATALOG_DB" 'select count(*) from products')"
  echo "inventory.balances=$(pg inventory-postgres "$INVENTORY_DB_USER" "$INVENTORY_DB" 'select count(*) from inventory_balances')"
  echo "payment.attempts=$(pg payment-postgres "$PAYMENT_DB_USER" "$PAYMENT_DB" 'select count(*) from payment_attempts')"
  echo "orders.orders=$(my 'select count(*) from orders' "$MYSQL_DB")"
  echo "auth.users=$(mongo "$MONGO_DB" 'db.users.countDocuments()')"
}

echo "== counts before restart"
counts | tee "$TMP/before"

echo "== restart (down WITHOUT -v, then up)"
dc down
dc up -d
for _ in $(seq 1 60); do
  bad=$(dc ps --format '{{.Name}} {{.Health}}' | awk '$2!="" && $2!="healthy"' | wc -l)
  [ "$bad" = 0 ] && break
  sleep 3
done
dc ps --format '{{.Name}} {{.Health}}' | awk '$2!="" && $2!="healthy"'
echo "== counts after restart"
counts | tee "$TMP/after"
diff "$TMP/before" "$TMP/after" && echo "PERSISTENCE OK: identical counts after restart"

echo "== backup, then restore into scratch databases"
scripts/backup.sh | tail -1
DIR=$(ls -d infrastructure/backups/*/ | sort | tail -1)
(cd "$DIR" && sha256sum -c SHA256SUMS >/dev/null) && echo "checksums ok"

for spec in "catalog-postgres:$CATALOG_DB_USER:$CATALOG_DB:products" "inventory-postgres:$INVENTORY_DB_USER:$INVENTORY_DB:inventory_balances" "payment-postgres:$PAYMENT_DB_USER:$PAYMENT_DB:payment_attempts"; do
  IFS=: read -r svc user db tbl <<<"$spec"
  dc exec -T "$svc" psql -U "$user" -d postgres -qc "drop database if exists scratch_restore" -c "create database scratch_restore"
  dc exec -T "$svc" pg_restore -U "$user" -d scratch_restore --no-owner < "${DIR}${svc}.dump"
  live=$(pg "$svc" "$user" "$db" "select count(*) from $tbl")
  got=$(pg "$svc" "$user" scratch_restore "select count(*) from $tbl")
  dc exec -T "$svc" psql -U "$user" -d postgres -qc "drop database scratch_restore"
  [ "$live" = "$got" ] || { echo "MISMATCH $svc.$tbl live=$live restored=$got"; exit 1; }
  echo "restore check $svc.$tbl: restored=$got live=$live OK"
done

my 'drop database if exists scratch_restore; create database scratch_restore'
dc exec -T -e MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql mysql -uroot scratch_restore < "${DIR}mysql.sql"
live=$(my 'select count(*) from orders' "$MYSQL_DB"); got=$(my 'select count(*) from orders' scratch_restore)
my 'drop database scratch_restore'
[ "$live" = "$got" ] || { echo "MISMATCH mysql.orders live=$live restored=$got"; exit 1; }
echo "restore check mysql.orders: restored=$got live=$live OK"

dc exec -T mongodb mongorestore -u "$MONGO_ROOT_USER" -p "$MONGO_ROOT_PASSWORD" --authenticationDatabase admin --archive --gzip --nsFrom "$MONGO_DB.*" --nsTo "scratch_restore.*" < "${DIR}mongodb.archive.gz" 2>&1 | tail -1
live=$(mongo "$MONGO_DB" 'db.users.countDocuments()'); got=$(mongo scratch_restore 'db.users.countDocuments()')
mongo scratch_restore 'db.dropDatabase()' >/dev/null
[ "$live" = "$got" ] || { echo "MISMATCH mongo.users live=$live restored=$got"; exit 1; }
echo "restore check mongo.users: restored=$got live=$live OK"
echo "ALL DURABILITY CHECKS PASSED"
