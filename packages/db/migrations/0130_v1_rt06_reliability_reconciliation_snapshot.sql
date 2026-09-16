-- RT-06 (§19.0): "Reconciliation snapshots are process-local" --
-- setReconciliationSnapshot (apps/api/src/observability/metrics.ts) held the
-- L09 reliability-reconciliation snapshot in a plain module variable. That
-- is correct for exactly one process. The moment more than one API instance
-- serves /internal/metrics, each instance's own /internal/metrics/reconcile
-- run only updates *that* instance's copy, and every other instance's
-- scrape renders whatever it last computed itself (possibly never, in which
-- case every gauge silently reads 0 -- which is indistinguishable from
-- "healthy").
--
-- Fix: one durable, singleton "latest snapshot" row, written by whichever
-- instance's reconciliation run last completed and read by every
-- instance's /internal/metrics scrape (apps/api/src/observability/
-- reconciliation-store.ts). Deliberately a singleton, replaced wholesale on
-- every write -- the same "latest wins" semantics the in-memory variable it
-- replaces already had; this is not an append-only audit log, and the
-- seven L09 counts it carries are themselves recomputed from durable
-- business tables (payments, alert_events, event_outbox_deliveries,
-- payment_webhook_deliveries, refunds) on every reconciliation run, so
-- there is no historical value to this table that those tables do not
-- already carry.
--
-- Same singleton-control-row shape as app_private.outbox_dispatch_lease
-- (migration 0129, RT-04/RT-05): one row, id fixed at 1, replaced under a
-- SECURITY DEFINER function rather than direct table access, RLS-enabled
-- with no policies (only the functions below ever touch it).
--
-- Depends on 0001-0129. Modifies no existing migration file; this is a new
-- forward migration only, per the operator's explicit instruction (RT-06
-- §5, "forward migration only, next free number after 0129"). Its own
-- rollback, should one ever be needed, is a new forward migration dropping
-- this table/these functions -- never an edit of this file.

create table if not exists public.reliability_reconciliation_snapshot (
  id smallint primary key default 1,
  captured_payments_without_live_event bigint not null default 0,
  duplicate_live_events bigint not null default 0,
  lost_deliveries bigint not null default 0,
  webhook_lag_ms_max bigint not null default 0,
  webhook_lag_ms_avg bigint not null default 0,
  refund_failures bigint not null default 0,
  observed_at timestamptz not null,
  updated_at timestamptz not null default current_timestamp,
  constraint reliability_reconciliation_snapshot_singleton check (id = 1),
  constraint reliability_reconciliation_snapshot_counts_non_negative check (
    captured_payments_without_live_event >= 0
    and duplicate_live_events >= 0
    and lost_deliveries >= 0
    and webhook_lag_ms_max >= 0
    and webhook_lag_ms_avg >= 0
    and refund_failures >= 0
  )
);

alter table public.reliability_reconciliation_snapshot enable row level security;
revoke all on public.reliability_reconciliation_snapshot from public;
revoke all on public.reliability_reconciliation_snapshot from bsa_app;

-- Replaces the singleton snapshot row wholesale. Only ever called from the
-- same service-identity-gated POST /internal/metrics/reconcile boundary
-- that already computes these seven bounded counts from durable business
-- tables (reconciliation.ts) -- this function receives already-computed
-- values, it does not itself touch payments/alert_events/etc.
create or replace function app_private.record_reliability_reconciliation_snapshot(
  target_captured_payments_without_live_event bigint,
  target_duplicate_live_events bigint,
  target_lost_deliveries bigint,
  target_webhook_lag_ms_max bigint,
  target_webhook_lag_ms_avg bigint,
  target_refund_failures bigint,
  target_observed_at timestamptz
)
returns void
language sql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
  insert into public.reliability_reconciliation_snapshot (
    id, captured_payments_without_live_event, duplicate_live_events,
    lost_deliveries, webhook_lag_ms_max, webhook_lag_ms_avg,
    refund_failures, observed_at, updated_at
  )
  values (
    1,
    greatest(coalesce(target_captured_payments_without_live_event, 0), 0),
    greatest(coalesce(target_duplicate_live_events, 0), 0),
    greatest(coalesce(target_lost_deliveries, 0), 0),
    greatest(coalesce(target_webhook_lag_ms_max, 0), 0),
    greatest(coalesce(target_webhook_lag_ms_avg, 0), 0),
    greatest(coalesce(target_refund_failures, 0), 0),
    coalesce(target_observed_at, current_timestamp),
    current_timestamp
  )
  on conflict (id) do update
    set captured_payments_without_live_event = excluded.captured_payments_without_live_event,
        duplicate_live_events = excluded.duplicate_live_events,
        lost_deliveries = excluded.lost_deliveries,
        webhook_lag_ms_max = excluded.webhook_lag_ms_max,
        webhook_lag_ms_avg = excluded.webhook_lag_ms_avg,
        refund_failures = excluded.refund_failures,
        observed_at = excluded.observed_at,
        updated_at = current_timestamp
$$;

-- Returns zero or one row: the singleton snapshot, or nothing when no
-- reconciliation run has ever completed durably. Callers (reconciliation-
-- store.ts) must keep treating "no row" as "no data yet," the same meaning
-- the in-memory `reconciliation === undefined` case it replaces already
-- had -- never as "all clear."
create or replace function app_private.latest_reliability_reconciliation_snapshot()
returns table (
  captured_payments_without_live_event bigint,
  duplicate_live_events bigint,
  lost_deliveries bigint,
  webhook_lag_ms_max bigint,
  webhook_lag_ms_avg bigint,
  refund_failures bigint,
  observed_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select
    captured_payments_without_live_event, duplicate_live_events, lost_deliveries,
    webhook_lag_ms_max, webhook_lag_ms_avg, refund_failures, observed_at
    from public.reliability_reconciliation_snapshot
   where id = 1
$$;

revoke execute on function app_private.record_reliability_reconciliation_snapshot(bigint, bigint, bigint, bigint, bigint, bigint, timestamptz) from public;
revoke execute on function app_private.latest_reliability_reconciliation_snapshot() from public;
grant execute on function app_private.record_reliability_reconciliation_snapshot(bigint, bigint, bigint, bigint, bigint, bigint, timestamptz) to bsa_app;
grant execute on function app_private.latest_reliability_reconciliation_snapshot() to bsa_app;
