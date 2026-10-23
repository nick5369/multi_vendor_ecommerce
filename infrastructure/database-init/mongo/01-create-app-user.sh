#!/bin/bash
# Runs once on first start of an empty mongo_data volume. Creates a least-privilege app user.
set -e
mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin "$MONGO_DB" <<EOF
db.createUser({ user: "$MONGO_APP_USER", pwd: "$MONGO_APP_PASSWORD", roles: [{ role: "readWrite", db: "$MONGO_DB" }] });
EOF
