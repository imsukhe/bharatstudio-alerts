#!/usr/bin/env sh
set -eu

# L14 viewer password reset — disposable-database test run. Applies ONLY
# migrations 0001 through 0088 (never the whole migrations directory
# unfiltered), mirroring run-l14-viewer-identity.sh's own bootstrap +
# 0002 remediation-then-rest ordering.

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
CONTAINER="bharatstudio-l14-reset-pg-$$"
PORT="${L14_RESET_PG_PORT:-55441}"

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
  # A fresh postgres image runs a TEMPORARY server during initdb, and this
  # pg_isready can catch that server's brief readiness window moments before
  # its socket disappears -- the next psql then fails with "No such file or
  # directory" while nothing is actually broken. It is a race, so it passes
  # most runs and fails some; it took CI's first two runs ever to expose it.
  # Every fresh container logs "database system is ready to accept
  # connections" exactly twice (temporary, then real); only the second one,
  # confirmed by a following pg_isready, is the real server. Same guard as
  # packages/db/tests/run-sql-suite.sh.
  if [ "$(docker logs "$CONTAINER" 2>&1 | grep -c 'database system is ready to accept connections')" -ge 2 ] \
    && docker exec "$CONTAINER" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
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

# The ceiling used to be hardcoded at 88, which silently froze this suite at
# the schema of the day it was written. Migration 0112 later bounded
# app_private.list_viewer_sessions to 100 rows; this harness never applied it,
# so its own "must cap at 100 rows" assertion failed against 0085's unbounded
# function -- and because this script is wired into neither CI nor
# `pnpm verify:local`, nothing ever reported it. Default to every committed
# migration, exactly as run-l03-application-behavior.sh does, and keep the
# explicit numeric filter (never an unbounded directory glob) so a mid-write
# file above the intended baseline can still be excluded on demand via
# MAX_MIGRATION.
MAX_MIGRATION_NUMBER=${MAX_MIGRATION:-$(ls "$ROOT"/packages/db/migrations/*.sql | sed 's#.*/##' | cut -c1-4 | sort -n | tail -1)}
# Strip leading zeros portably. `$((10#$n))` is a bashism: /bin/sh is dash on
# Ubuntu CI and rejects it ("arithmetic expression: expecting EOF"), while
# macOS /bin/sh is bash and accepts it -- so it passed locally and broke in CI.
MAX_MIGRATION_NUMBER=$(printf %s "$MAX_MIGRATION_NUMBER" | sed 's/^0*//')
[ -n "$MAX_MIGRATION_NUMBER" ] || MAX_MIGRATION_NUMBER=0

n=3
while [ "$n" -le "$MAX_MIGRATION_NUMBER" ]; do
  padded=$(printf '%04d' "$n")
  match=$(find "$ROOT/packages/db/migrations" -maxdepth 1 -name "${padded}_*.sql" | head -1)
  if [ -n "$match" ]; then
    psql < "$match" >/dev/null
  fi
  n=$((n + 1))
done

psql < "$ROOT/packages/db/tests/l14_viewer_password_reset.sql"
