#!/usr/bin/env bash
# DESTRUCTIVE: replaces the contents of the live databases with a backup made by scripts/backup.sh.
# Usage: scripts/restore.sh infrastructure/backups/<timestamp> --yes
# Stop the app services first (docker compose stop auth-service catalog-service order-service inventory-service payment-service)
# so nothing writes during the restore, then start them again afterwards.
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="${1:?usage: restore.sh <backup dir> --yes}"
[ "${2:-}" = "--yes" ] || { echo "Refusing: this overwrites live data. Re-run with --yes." >&2; exit 2; }
[ -d "$DIR" ] || { echo "no such directory: $DIR" >&2; exit 1; }
(cd "$DIR" && sha256sum -c SHA256SUMS)
set -a; . ./.env; set +a
dc() { docker compose "$@"; }

for spec in "catalog-postgres:$CATALOG_DB_USER:$CATALOG_DB" "inventory-postgres:$INVENTORY_DB_USER:$INVENTORY_DB" "payment-postgres:$PAYMENT_DB_USER:$PAYMENT_DB"; do
  IFS=: read -r svc user db <<<"$spec"
  dc exec -T "$svc" pg_restore -U "$user" -d "$db" --clean --if-exists --no-owner < "$DIR/$svc.dump"
  echo "restored $svc"
done
dc exec -T -e MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql mysql -uroot "$MYSQL_DB" < "$DIR/mysql.sql"
echo "restored mysql (tables are dropped/recreated by the dump)"
dc exec -T mongodb mongorestore -u "$MONGO_ROOT_USER" -p "$MONGO_ROOT_PASSWORD" --authenticationDatabase admin --archive --gzip --drop < "$DIR/mongodb.archive.gz"
echo "restored mongodb"
