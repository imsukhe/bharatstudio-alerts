#!/usr/bin/env sh
# Runs the packages/db/tests/*.sql suite against a disposable postgres:16-alpine
# container, then (unless DB_SQL_TESTS_ONLY=1) the Go/TS integration legs.
#
# One command, SQL suite only:
#   DB_SQL_TESTS_ONLY=1 packages/db/tests/run-l03-application-behavior.sh
#
# One command, full suite (SQL + service/app integration legs):
#   packages/db/tests/run-l03-application-behavior.sh
#
# Env vars:
#   L03_PG_PORT     host port for the throwaway container (default 55439)
#   MAX_MIGRATION   optional 4-digit upper bound, e.g. 0081. When set, only
#                   migrations numbered <= this are applied, by explicit
#                   numeric filename filtering (never by globbing the
#                   directory at an unbounded moment) — use this while other
#                   migrations are mid-write above your intended baseline.
#   DB_SQL_TESTS_ONLY  when "1", skip the Go/TS integration legs (services/*,
#                      apps/api) and only run the packages/db/tests/*.sql suite.
#
# Exits non-zero on the first failing statement/test (ON_ERROR_STOP=1 plus
# `set -e` on each `psql <` invocation; the Go/TS legs propagate their own
# non-zero exit the same way).
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
CONTAINER="bharatstudio-l03-pg-$$"
PORT="${L03_PG_PORT:-55439}"
MAX_MIGRATION="${MAX_MIGRATION:-}"
DB_SQL_TESTS_ONLY="${DB_SQL_TESTS_ONLY:-0}"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -f "$ROOT/packages/db/tests/.migration-list.tmp" 2>/dev/null || true
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

# Numeric-prefix filter so a migration lane concurrently adding files above
# MAX_MIGRATION can never be picked up mid-write: this walks a fixed,
# pre-enumerated list rather than re-globbing the directory per file.
migration_within_bound() {
  file_prefix=$(basename "$1" | cut -c1-4)
  if [ -z "$MAX_MIGRATION" ]; then
    return 0
  fi
  [ "$file_prefix" -le "$MAX_MIGRATION" ] 2>/dev/null
}

psql < "$ROOT/packages/db/roles/0001_v1_service_roles.sql" >/dev/null
psql < "$ROOT/packages/db/migrations/0001_v1_baseline.sql" >/dev/null
psql < "$ROOT/packages/db/migrations/0002_v1_security_rls_archive.sql" >/dev/null
psql < "$ROOT/packages/db/tests/l02_security_remediations.sql"
find "$ROOT/packages/db/migrations" -maxdepth 1 -name '*.sql' | sort > "$ROOT/packages/db/tests/.migration-list.tmp"
while IFS= read -r migration; do
  case "$migration" in
    *0001_v1_baseline.sql|*0002_v1_security_rls_archive.sql) continue ;;
  esac
  if ! migration_within_bound "$migration"; then
    continue
  fi
  psql < "$migration" >/dev/null
done < "$ROOT/packages/db/tests/.migration-list.tmp"
rm -f "$ROOT/packages/db/tests/.migration-list.tmp"

sql_test_count=0
run_sql_test() {
  sql_test_count=$((sql_test_count + 1))
  psql < "$ROOT/packages/db/tests/$1"
}

run_sql_test l03_application_behavior.sql
run_sql_test l03_payment_ledger_read.sql
run_sql_test l03_featured_creator_listing.sql
run_sql_test l03_admin_dlq_tooling.sql
run_sql_test l03_admin_entitlement_management.sql
run_sql_test l02_l04_email_delivery.sql
run_sql_test l02_terms_consent.sql
run_sql_test l03_tts_event_enrichment.sql
run_sql_test rt02_overlay_events_artifact_column.sql
run_sql_test l03_tts_usage_metering.sql
run_sql_test rt03_tts_quota_reservation_release.sql
run_sql_test rt04_outbox_dispatch_lease.sql
run_sql_test rt06_reliability_reconciliation_snapshot.sql
run_sql_test l03_entitlement_retier_and_dimensions.sql
run_sql_test l03_queue_mode_ladder.sql
run_sql_test l05_queue_policy_enforcement.sql
run_sql_test l04_reconciliation_quarantine.sql
run_sql_test l04_payment_account_onboarding.sql
run_sql_test l04_downgrade_enforcement.sql
run_sql_test l07_notification_preferences.sql
run_sql_test l03_referral_growth_engine.sql
run_sql_test l03_lottie_branding_upload.sql
run_sql_test l14_viewer_identity.sql
run_sql_test prf02_master_canvas_module_cap.sql
run_sql_test prf02_slice2_tug_of_war_vote.sql

echo "DB_TESTS_SQL_SUITE: ${sql_test_count} file(s) passed" >&2

if [ "$DB_SQL_TESTS_ONLY" = "1" ]; then
  exit 0
fi

(cd "$ROOT/services/payment-webhook-go" && \
  BSA_PAYMENT_SQL_DSN="postgres://postgres:test@127.0.0.1:${PORT}/postgres?sslmode=disable" \
  go test -tags=integration ./internal/ingress -run TestSQLStoreRoundTripAgainstPostgres -count=1)

(cd "$ROOT/services/payment-webhook-go" && \
  BSA_PAYMENT_SQL_DSN="postgres://postgres:test@127.0.0.1:${PORT}/postgres?sslmode=disable" \
  go test -tags=integration ./internal/reconcile -run TestSQLStoreListsAccountScopedCandidatesAgainstPostgres -count=1)

(cd "$ROOT/services/alert-worker-go" && \
  BSA_ALERT_WORKER_SQL_DSN="postgres://postgres:test@127.0.0.1:${PORT}/postgres?sslmode=disable" \
  go test -tags=integration ./internal/store -run TestSQLDeliveryStoreClaimReleaseAgainstPostgres -count=1)

(cd "$ROOT/apps/api" && \
  BSA_OVERLAY_WAKEUP_SQL_DSN="postgres://postgres:test@127.0.0.1:${PORT}/postgres?sslmode=disable" \
  pnpm run test:overlay-wakeup:integration)

(cd "$ROOT/apps/api" && \
  BSA_OVERLAY_CROSS_REPLICA_SQL_DSN="postgres://postgres:test@127.0.0.1:${PORT}/postgres?sslmode=disable" \
  pnpm exec tsx ../../integration/overlay-cross-replica.integration.ts)

(cd "$ROOT/apps/api" && \
  BSA_CHANNEL_STORE_SQL_DSN="postgres://postgres:test@127.0.0.1:${PORT}/postgres?sslmode=disable" \
  pnpm exec tsx ../../integration/channel-store-concurrency.integration.ts)

# PRF-02 slice 7 hostile-review finding #2: the safe-soundboard store's
# Postgres errcode 55000 -> outcome 'caps_not_configured' mapping,
# exercised against a real database -- see that file's own header for why
# neither the SQL suite above nor the route tests cover this seam.
(cd "$ROOT/apps/api" && \
  BSA_SAFE_SOUNDBOARD_SQL_DSN="postgres://postgres:test@127.0.0.1:${PORT}/postgres?sslmode=disable" \
  pnpm exec tsx ../../integration/safe-soundboard-caps-not-configured.integration.ts)
