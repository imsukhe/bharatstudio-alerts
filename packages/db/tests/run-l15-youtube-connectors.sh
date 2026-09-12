#!/usr/bin/env sh
# L15 test harness — applies ONLY migrations 0001 through 0086 by explicit
# filename (never a glob over the migrations directory, since other lanes'
# in-flight migrations may sit alongside these at any given moment) and
# runs the L15 YouTube-connector acceptance checks against a disposable
# PostgreSQL 16 container.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
CONTAINER="bharatstudio-l15-pg-$$"
PORT="${L15_PG_PORT:-55440}"

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
psql < "$ROOT/packages/db/tests/l02_security_remediations.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0003_v1_l03_application.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0004_v1_l05_delivery_leases.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0005_v1_l05_overlay_wakeup.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0006_v1_l04_payment_order_intents.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0007_v1_l04_webhook_persistence.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0008_v1_l04_reconciliation.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0009_v1_l05_ready_delivery_listing.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0010_v1_l31_l32_delivery_snapshots.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0011_v1_l06_maintenance_runs.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0012_v1_l04_complete_payment_recovery.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0013_v1_l04_refund_reconciliation.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0014_v1_l04_refund_webhook_status_sync.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0015_v1_l05_outbox_projection_refresh.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0016_v1_l06_overlay_session_maintenance.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0017_v1_l03_moderation_event_scope.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0018_v1_l03_binding_queue_scope.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0019_v1_l03_manual_alert_deliveries.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0020_v1_l32_overlay_delivery_projection.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0021_v1_l03_duplicate_consent_guard.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0022_v1_l05_overlay_ack_release.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0023_v1_l05_queue_pause_dispatch_guard.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0024_v1_l02_archive_transfer.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0025_v1_l03_default_alert_queue.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0026_v1_l03_open_queue_delivery_guard.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0027_v1_l03_history_cursor_tiebreak.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0028_v1_l04_capture_projection_dedup.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0029_v1_l05_overlay_config_snapshot.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0030_v1_l05_publication_marker.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0031_v1_l04_dispute_evidence.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0032_v1_l32_source_rate_limit_and_publication_claim_guard.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0033_v1_l03_companion_test_result.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0034_v1_l04_reconciliation_account_attribution.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0035_v1_l04_refund_account_attribution.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0036_v1_l03_default_payment_binding.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0037_v1_l03_binding_identity_guard.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0038_v1_l03_open_binding_queue_guard.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0039_v1_l03_role_scoped_financial_reads.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0040_v1_l03_overlay_companion_role_guards.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0041_v1_l07_companion_action_contract.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0042_v1_l07_companion_action_layout.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0043_v1_l03_l04_channel_tip_minimum.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0044_v1_l03_public_payment_status.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0045_v1_l04_payment_intent_expiry_cap.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0046_v1_l04_webhook_event_id_format.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0047_v1_l02_soft_archive_only.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0048_v1_l04_subscription_billing_projection.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0049_v1_l04_subscription_webhook_projection.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0050_v1_l04_platform_subscription_account_boundary.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0051_v1_l04_subscription_creation_intents.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0052_v1_l04_quarantined_subscription_replay.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0053_v1_l07_companion_control_sessions.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0054_v1_l03_overlay_event_channel_guard.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0055_v1_l03_unacknowledged_replay_guard.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0056_v1_l04_payment_intent_idempotency_hardening.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0057_v1_l07_notification_preferences_and_devices.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0058_v1_l02_archive_owner_rls_hardening.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0059_v1_l04_reconciliation_manual_review_quarantine.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0060_v1_l04_creator_payment_account_onboarding.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0061_v1_l02_account_lifecycle_consent.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0062_v1_l03_l05_queue_policy_enforcement.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0063_v1_l05_l32_queue_claim_regression_fix.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0064_v1_l03_overlay_policy_replay_guard.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0065_v1_l05_queue_mode_ordering.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0066_v1_l02_terms_fail_closed_without_active_documents.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0067_v1_l03_tts_event_enrichment.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0068_v1_l02_seed_terms_documents.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0069_v1_l04_subscription_lifecycle_requests.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0070_v1_l03_l04_downgrade_enforcement.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0071_v1_l03_payment_ledger_read.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0072_v1_l03_featured_creator_listing.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0073_v1_l03_admin_dlq_tooling.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0074_v1_l03_admin_entitlement_management.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0075_v1_l02_l03_l04_email_delivery.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0076_v1_l03_referral_growth_engine.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0077_v1_l03_lottie_branding_upload.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0078_v1_l03_l04_free_billing_view_default_shape.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0079_v1_l03_payout_onboarding_gate.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0080_v1_l03_entitlement_retier_and_dimensions.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0081_v1_l03_tts_usage_metering.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0082_v1_l07_companion_device_pairing.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0083_v1_l03_queue_mode_ladder_correction.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0084_v1_l14_viewer_identity.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0085_v1_l14_viewer_sessions_and_deletion.sql" >/dev/null
  psql < "$ROOT/packages/db/migrations/0086_v1_l15_youtube_connectors.sql" >/dev/null
psql < "$ROOT/packages/db/tests/l15_youtube_connectors.sql"
echo 'L15 youtube-connector acceptance checks passed.'
