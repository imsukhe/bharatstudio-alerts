#!/usr/bin/env sh
# Boots a disposable PostgreSQL 16 container, applies every migration, then
# runs the L09 load harness against it. Same disposable-container convention
# as scripts/fixtures/run-self-test.sh and packages/db/tests/
# run-l03-application-behavior.sh. This is a LOCAL load run against a
# throwaway container on one machine — not a staging or production load
# test. See load-harness.ts's file header for the full scope statement.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
CONTAINER="bharatstudio-load-pg-$$"
PORT="${LOAD_PG_PORT:-55441}"

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
  LOAD_TIP_COUNT="${LOAD_TIP_COUNT:-50}" \
  LOAD_CONCURRENCY="${LOAD_CONCURRENCY:-10}" \
  "$ROOT/apps/api/node_modules/.bin/tsx" "$ROOT/scripts/load/load-harness.ts"
