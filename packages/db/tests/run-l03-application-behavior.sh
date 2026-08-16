#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
CONTAINER="bharatstudio-l03-pg-$$"
PORT="${L03_PG_PORT:-55439}"

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
for migration in "$ROOT"/packages/db/migrations/*.sql; do
  case "$migration" in
    *0001_v1_baseline.sql|*0002_v1_security_rls_archive.sql) continue ;;
  esac
  psql < "$migration" >/dev/null
done
psql < "$ROOT/packages/db/tests/l03_application_behavior.sql"
psql < "$ROOT/packages/db/tests/l03_payment_ledger_read.sql"
psql < "$ROOT/packages/db/tests/l03_featured_creator_listing.sql"
psql < "$ROOT/packages/db/tests/l03_admin_dlq_tooling.sql"
psql < "$ROOT/packages/db/tests/l03_admin_entitlement_management.sql"
psql < "$ROOT/packages/db/tests/l02_terms_consent.sql"
psql < "$ROOT/packages/db/tests/l03_tts_event_enrichment.sql"
psql < "$ROOT/packages/db/tests/l05_queue_policy_enforcement.sql"
psql < "$ROOT/packages/db/tests/l04_reconciliation_quarantine.sql"
psql < "$ROOT/packages/db/tests/l04_payment_account_onboarding.sql"
psql < "$ROOT/packages/db/tests/l04_downgrade_enforcement.sql"
psql < "$ROOT/packages/db/tests/l07_notification_preferences.sql"

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
