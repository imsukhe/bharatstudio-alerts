#!/bin/sh
# Runs every packages/db/tests/*.sql file in ITS OWN database.
#
# Why this exists: the SQL test files were each written assuming they are the
# first thing to touch a fresh schema, so several seed the same synthetic ids
# (e.g. app_users '...0001') without `on conflict`. Run sequentially against one
# shared database they contaminate each other, and which file fails depends on
# alphabetical order rather than on correctness. Isolating each file removes
# that entire class of false failure, and keeps a genuinely order-dependent test
# from ever passing by luck.
#
# Each file gets a fresh database cloned from a template that already has the
# roles and migrations applied, so isolation costs a clone, not a re-migration.
#
# Usage:  sh packages/db/tests/run-sql-suite.sh [MAX_MIGRATION]
#   MAX_MIGRATION - optional 4-digit upper bound (default: all).
#                   Migrations are enumerated once, up front, and filtered by
#                   number - never re-globbed mid-run, so a concurrently
#                   written migration cannot be swept into an in-flight run.
set -eu

MAX="${1:-9999}"
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"  # repo root (bharatstudio-alerts)
CONTAINER="bs-sqlsuite-$$"

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

docker run -d --rm --name "$CONTAINER" \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=template_bs \
  postgres:16-alpine >/dev/null

# The official postgres image performs its own initdb on a fresh (unvolumed)
# container: it starts a TEMPORARY server on the Unix socket to run init
# scripts, shuts it down, then starts the real long-running server. A bare
# `pg_isready` loop can catch that temporary server's brief readiness window
# and declare victory, moments before its socket disappears -- the next
# command then fails with "No such file or directory" even though nothing
# is actually broken. Every fresh container here logs "database system is
# ready to accept connections" exactly twice (temporary, then real); only
# the second one, confirmed by a subsequent pg_isready, is the real server.
i=0
until [ "$(docker logs "$CONTAINER" 2>&1 | grep -c 'database system is ready to accept connections')" -ge 2 ] \
  && docker exec "$CONTAINER" pg_isready -U postgres -d template_bs >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -gt 60 ] && { echo "postgres did not become ready"; exit 1; }
  sleep 1
done

psql_t() { docker exec -i "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -q "$@"; }

for f in "$REPO"/packages/db/roles/*.sql; do
  psql_t -d template_bs < "$f" >/dev/null
done

# Enumerate migrations ONCE into a fixed list, then filter by number. The list
# is captured up front so a migration written by a concurrent process mid-run
# can never be swept in. Paths may contain spaces, so iterate line-by-line.
MIGLIST=$(mktemp)
ls "$REPO"/packages/db/migrations/*.sql > "$MIGLIST"
APPLIED=0
while IFS= read -r f; do
  n=$(basename "$f" | cut -c1-4)
  [ "$n" -le "$MAX" ] || continue
  psql_t -d template_bs < "$f" >/dev/null
  APPLIED=$((APPLIED + 1))
done < "$MIGLIST"
rm -f "$MIGLIST"
# Shared base world (see fixtures/00_base_world.sql for why this exists).
psql_t -d template_bs < "$REPO"/packages/db/tests/fixtures/00_base_world.sql >/dev/null
echo "template ready: $APPLIED migrations (max=$MAX) + base world"

PASS=0; FAIL=0; FAILED=""
TESTLIST=$(mktemp)
ls "$REPO"/packages/db/tests/*.sql > "$TESTLIST"   # fixtures/ is a subdir, not matched
while IFS= read -r f; do
  name=$(basename "$f" .sql)
  db="t_$(echo "$name" | tr -c 'a-z0-9' '_')"
  docker exec "$CONTAINER" psql -U postgres -d postgres -q \
    -c "create database $db template template_bs" >/dev/null
  if psql_t -d "$db" < "$f" >/tmp/sqlsuite.out 2>&1; then
    PASS=$((PASS + 1)); echo "  PASS $name"
  else
    FAIL=$((FAIL + 1)); FAILED="$FAILED $name"
    echo "  FAIL $name"
    grep -E '^(ERROR|DETAIL)' /tmp/sqlsuite.out | head -3 | sed 's/^/       /'
  fi
done < "$TESTLIST"
rm -f "$TESTLIST"

echo "SQL SUITE: pass=$PASS fail=$FAIL"
[ -n "$FAILED" ] && echo "failed:$FAILED"
[ "$FAIL" -eq 0 ]
