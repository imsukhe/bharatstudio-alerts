#!/usr/bin/env sh
# PRF-01 relative-regression gate.
#
# Scope decided by the owner 2026-09-16 (recorded in full in
# bharatstudio-requirements/reviews/2026-09-16-ops-ci-01-alerts-continuous-integration.md):
#
#   SAMPLE RULE: §37.4's own repeatability discipline, reused rather than
#   invented — "Three runs. The worst run is the result." This script runs
#   scripts/load/load-harness.ts three times against one disposable
#   PostgreSQL 16 container (same boot sequence as
#   scripts/load/run-l09-load-self-test.sh) and takes the WORST (max) of
#   each percentile across the three runs.
#
#   TOLERANCE: none. Any degradation of the worst-of-three against the
#   checked-in baseline (.github/ci/perf-baseline.local-load.json) fails
#   the build. No percentage band — the owner deliberately chose the
#   strictest option over inventing a tolerance figure no authority
#   states. The accepted trade, recorded here as the risk it is: with no
#   band, this check CAN fail on ordinary CI-runner variance rather than a
#   real regression. When it fires: re-run first. If it reproduces, treat
#   it as a regression — never widen the baseline to make a flake go away.
#
# HONESTY — read this before treating a pass as good news. This harness
# (scripts/load/load-harness.ts) runs 20 synthetic tips at concurrency 5
# against one disposable local Postgres container on one CI runner. It is
# the same "local SQL harness" RT-06 names explicitly as SQL-correctness
# evidence only — it runs no HTTP, no Razorpay, no Cloud Tasks, no real
# overlay SSE connection, and it is not §19.4's production concurrency
# target (2,000 overlays). A pass here is a LOCAL TREND SIGNAL — it can
# catch a real regression introduced on this laptop-shaped container, and
# nothing more. It is not evidence any §19.4 budget is met in production.
# RT-07 (real browser/OBS/device/staging evidence): Blocked.
# externalEvidence: not-claimed.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
CONTAINER="bharatstudio-relreg-pg-$$"
PORT="${RELREG_PG_PORT:-55444}"
RUNS=3
LOAD_TIP_COUNT="${LOAD_TIP_COUNT:-20}"
LOAD_CONCURRENCY="${LOAD_CONCURRENCY:-5}"
WORKDIR=$(mktemp -d)

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
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

i=1
while [ "$i" -le "$RUNS" ]; do
  echo "relative-regression: run $i/$RUNS (LOAD_TIP_COUNT=$LOAD_TIP_COUNT LOAD_CONCURRENCY=$LOAD_CONCURRENCY)" >&2
  DATABASE_URL_DIRECT="postgres://postgres:test@127.0.0.1:${PORT}/postgres" \
    NODE_PATH="$ROOT/apps/api/node_modules" \
    LOAD_TIP_COUNT="$LOAD_TIP_COUNT" \
    LOAD_CONCURRENCY="$LOAD_CONCURRENCY" \
    "$ROOT/apps/api/node_modules/.bin/tsx" "$ROOT/scripts/load/load-harness.ts" > "$WORKDIR/run-$i.json"
  i=$((i + 1))
done

node "$ROOT/.github/scripts/relative-regression-compare.mjs" \
  "$WORKDIR/run-1.json" "$WORKDIR/run-2.json" "$WORKDIR/run-3.json" \
  "$ROOT/.github/ci/perf-baseline.local-load.json"
