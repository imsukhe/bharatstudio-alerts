#!/usr/bin/env sh
set -eu

# L14 viewer identity — disposable-database test run. Applies ONLY migrations
# 0001 through 0085 (never the whole migrations directory unfiltered — a
# later lane's file numbered above 0085, or a not-yet-numbered draft, must
# not be picked up here), mirroring run-l03-application-behavior.sh's role
# bootstrap + 0002 remediation-then-rest ordering.

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
CONTAINER="bharatstudio-l14-pg-$$"
PORT="${L14_PG_PORT:-55440}"

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
if [ "$ready" -ne 1 ]; then
  echo 'PostgreSQL 16 did not become ready' >&2
  exit 1
fi

psql() {
  docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d postgres "$@"
}

psql < "$ROOT/packages/db/roles/0001_v1_service_roles.sql" >/dev/null
psql < "$ROOT/packages/db/migrations/0001_v1_baseline.sql" >/dev/null
psql < "$ROOT/packages/db/migrations/0002_v1_security_rls_archive.sql" >/dev/null
psql < "$ROOT/packages/db/tests/l02_security_remediations.sql"

n=3
while [ "$n" -le 85 ]; do
  padded=$(printf '%04d' "$n")
  match=$(find "$ROOT/packages/db/migrations" -maxdepth 1 -name "${padded}_*.sql" | head -1)
  if [ -n "$match" ]; then
    psql < "$match" >/dev/null
  fi
  n=$((n + 1))
done

psql < "$ROOT/packages/db/tests/l14_viewer_identity.sql"
