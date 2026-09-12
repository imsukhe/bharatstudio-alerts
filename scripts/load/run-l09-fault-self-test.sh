#!/usr/bin/env sh
# Boots a disposable PostgreSQL 16 container, applies every migration, then
# runs l09-fault-duplicate-webhook-self-test.ts against it, with the fault
# injector deliberately switched on in this non-production shell only
# (BSA_FAULT_INJECTION_ENABLE=1, NODE_ENV=test). Same convention as
# scripts/fixtures/run-self-test.sh.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
CONTAINER="bharatstudio-l09-fault-pg-$$"
PORT="${L09_FAULT_PG_PORT:-55443}"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker run --rm --detach --name "$CONTAINER" \
  -e POSTGRES_PASSWORD=test \
  -p "127.0.0.1:${PORT}:5432" \
  postgres:16-alpine >/dev/null

ready=0
for _attempt in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[ "$ready" -eq 1 ] || { echo 'PostgreSQL 16 did not become ready' >&2; exit 1; }

psql() {
  docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d postgres "$@"
}

psql < "$ROOT/packages/db/roles/0001_v1_service_roles.sql" >/dev/null
for migration in "$ROOT"/packages/db/migrations/*.sql; do
  psql < "$migration" >/dev/null
done

DATABASE_URL_DIRECT="postgres://postgres:test@127.0.0.1:${PORT}/postgres" \
  NODE_PATH="$ROOT/apps/api/node_modules" \
  NODE_ENV=test \
  BSA_FAULT_INJECTION_ENABLE=1 \
  "$ROOT/apps/api/node_modules/.bin/tsx" "$ROOT/scripts/load/l09-fault-duplicate-webhook-self-test.ts"
