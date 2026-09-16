-- RT-06 / migration 0130: app_private.record_reliability_reconciliation_snapshot
-- and app_private.latest_reliability_reconciliation_snapshot are the durable
-- replacement for the process-local `setReconciliationSnapshot` module
-- variable (apps/api/src/observability/metrics.ts). This file proves the
-- cross-instance correctness property RT-06 §3.4 requires: a snapshot
-- recorded by one database session (standing in for one API instance) is
-- visible, correct, and current to a second, independent session (standing
-- in for a second API instance) -- not stale, not zeroed, not
-- process-local.
--
--   1. no row exists before the first reconciliation run: latest() returns
--      zero rows, matching the in-memory "undefined" case it replaces;
--   2. session A records a snapshot; session B (a fresh connection, no
--      shared state, the actual cross-instance proof) reads back the exact
--      same values;
--   3. a second, later reconciliation run from session A (simulating that
--      instance's next scheduled pass) replaces the singleton row
--      wholesale, and session B's next read sees the new values, not the
--      old ones and not a merge of both -- "latest wins," same as the
--      in-memory variable always meant;
--   4. a pathological negative input (defensive; should never happen from
--      reconciliation.ts, which only ever produces counts from `count(*)`)
--      is clamped to zero rather than stored negative or raising;
--   5. only bsa_app can reach the snapshot at all, and only through these
--      two functions -- direct table access is denied even to that role,
--      matching every other app_private control table in this schema.
--
-- No payment, order, event, channel or donor identifier is involved: the
-- snapshot carries only the seven bounded L09 counts/timestamps
-- ReconciliationSnapshot already carries, so this file has no synthetic id
-- range to reserve.

\set ON_ERROR_STOP on

-- 1. No reconciliation has ever run: latest() returns no rows.
begin;
set local role bsa_app;
do $$
declare
  v_count integer;
begin
  select count(*) into v_count from app_private.latest_reliability_reconciliation_snapshot();
  if v_count <> 0 then raise exception 'expected no snapshot row before the first reconciliation run'; end if;
end
$$;
rollback;

-- 2. Session A records a snapshot.
begin;
set local role bsa_app;
select app_private.record_reliability_reconciliation_snapshot(
  4::bigint, 2::bigint, 9::bigint, 1500::bigint, 300::bigint, 1::bigint,
  '2026-09-16T00:00:00Z'::timestamptz
);
commit;

-- Session B: a fresh connection, no shared in-process state whatsoever --
-- this is the actual cross-instance proof, not merely "read after write in
-- the same session."
\connect - -
set role bsa_app;
do $$
declare
  v_captured bigint; v_duplicate bigint; v_lost bigint; v_lag_max bigint; v_lag_avg bigint; v_refund bigint; v_observed timestamptz;
begin
  select captured_payments_without_live_event, duplicate_live_events, lost_deliveries,
         webhook_lag_ms_max, webhook_lag_ms_avg, refund_failures, observed_at
    into v_captured, v_duplicate, v_lost, v_lag_max, v_lag_avg, v_refund, v_observed
    from app_private.latest_reliability_reconciliation_snapshot();
  if v_captured is distinct from 4 or v_duplicate is distinct from 2 or v_lost is distinct from 9
     or v_lag_max is distinct from 1500 or v_lag_avg is distinct from 300 or v_refund is distinct from 1
     or v_observed is distinct from '2026-09-16T00:00:00Z'::timestamptz then
    raise exception 'a second, independent session must read back the exact snapshot the first session recorded';
  end if;
end
$$;
reset role;

-- 3. A later reconciliation run replaces the singleton row wholesale
-- ("latest wins", never a merge) -- recorded from a third, independent
-- session, read from a fourth.
\connect - -
set role bsa_app;
select app_private.record_reliability_reconciliation_snapshot(
  0::bigint, 0::bigint, 0::bigint, 250::bigint, 80::bigint, 0::bigint,
  '2026-09-16T00:05:00Z'::timestamptz
);
reset role;

\connect - -
set role bsa_app;
do $$
declare
  v_count integer; v_captured bigint; v_lag_max bigint; v_observed timestamptz;
begin
  select count(*) into v_count from app_private.latest_reliability_reconciliation_snapshot();
  if v_count <> 1 then raise exception 'the snapshot must stay a singleton row, never accumulate history'; end if;

  select captured_payments_without_live_event, webhook_lag_ms_max, observed_at
    into v_captured, v_lag_max, v_observed
    from app_private.latest_reliability_reconciliation_snapshot();
  if v_captured is distinct from 0 or v_lag_max is distinct from 250
     or v_observed is distinct from '2026-09-16T00:05:00Z'::timestamptz then
    raise exception 'the later reconciliation run must fully replace the earlier snapshot, not merge with it';
  end if;
end
$$;
reset role;

-- 4. A pathological negative input (defensive only -- reconciliation.ts
-- only ever produces non-negative counts) is clamped to zero rather than
-- stored negative or raising. Measurement must never fail the caller.
begin;
set local role bsa_app;
select app_private.record_reliability_reconciliation_snapshot(
  (-5)::bigint, 1::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint,
  current_timestamp
);
do $$
declare
  v_captured bigint;
begin
  select captured_payments_without_live_event into v_captured
    from app_private.latest_reliability_reconciliation_snapshot();
  if v_captured <> 0 then raise exception 'a negative input must be clamped to zero, never stored negative'; end if;
end
$$;
rollback;

-- 5. Direct table access is denied even to bsa_app -- the snapshot is
-- reachable only through the two functions above.
begin;
set local role bsa_app;
do $$
begin
  perform 1 from public.reliability_reconciliation_snapshot;
  raise exception 'bsa_app must not have direct select on public.reliability_reconciliation_snapshot';
exception
  when insufficient_privilege then
    null;
end
$$;
commit;

select 'RT06_RELIABILITY_RECONCILIATION_SNAPSHOT=PASS' as result;
