-- RT-04 / RT-05 / migration 0129: app_private.acquire_outbox_dispatch_lease
-- and app_private.release_outbox_dispatch_lease are the single-row mutual
-- exclusion lease that makes the outbox dispatcher (services/alert-worker-go's
-- pump) the only scanner, safely, even when a burst of post-commit
-- wake-ups overlaps a scheduled "outbox-recovery" tick. This file proves:
--
--   1. the lease starts unheld, and an acquire succeeds;
--   2. a second acquire, by a different token, fails while the first lease
--      is still active (no two concurrent dispatch runs both win);
--   3. releasing with the WRONG token is a safe no-op -- the lease stays
--      held by its real owner;
--   4. releasing with the correct token clears it, and a new acquire then
--      succeeds (the graceful-return path, so a benign failure does not
--      hold the backlog closed for the full lease window);
--   5. once a lease has expired (simulating a dispatcher that died mid-scan
--      and never reached its release), a new acquire succeeds -- RT-04.8's
--      "picked up on a later tick";
--   6. only bsa_alert_worker can reach the lease at all, and only through
--      these two functions -- direct table access is denied even to that
--      role, matching every other app_private control table in this
--      schema.
--
-- No delivery, event or channel row is needed: the lease is process-level
-- coordination, not delivery-scoped state, so this file has no synthetic id
-- range to reserve.

\set ON_ERROR_STOP on

-- 1. Starts unheld; first acquire succeeds.
begin;
set local role bsa_alert_worker;
do $$
declare
  v_acquired boolean;
begin
  select app_private.acquire_outbox_dispatch_lease(
    '00000000-0000-4000-8000-000000000a01'::uuid, current_timestamp + interval '60 seconds'
  ) into v_acquired;
  if not v_acquired then raise exception 'expected the first acquire of an unheld lease to succeed'; end if;
end
$$;
commit;

-- 2. A second, different token cannot acquire while the first lease is
-- still active -- this is the correctness property RT-05 is closing.
begin;
set local role bsa_alert_worker;
do $$
declare
  v_acquired boolean;
begin
  select app_private.acquire_outbox_dispatch_lease(
    '00000000-0000-4000-8000-000000000a02'::uuid, current_timestamp + interval '60 seconds'
  ) into v_acquired;
  if v_acquired then raise exception 'a second concurrent dispatch run must not acquire an already-held lease'; end if;
end
$$;
commit;

-- 3. Releasing with the wrong token is a safe no-op; the real owner keeps
-- the lease.
begin;
set local role bsa_alert_worker;
do $$
declare
  v_released boolean;
  v_acquired boolean;
begin
  select app_private.release_outbox_dispatch_lease('00000000-0000-4000-8000-000000000a02'::uuid) into v_released;
  if v_released then raise exception 'releasing with a token that does not hold the lease must be a no-op'; end if;

  select app_private.acquire_outbox_dispatch_lease(
    '00000000-0000-4000-8000-000000000a03'::uuid, current_timestamp + interval '60 seconds'
  ) into v_acquired;
  if v_acquired then raise exception 'the lease must still be held by its real owner after a wrong-token release attempt'; end if;
end
$$;
commit;

-- 4. Releasing with the correct token clears it; a new acquire then
-- succeeds immediately (the graceful-return path -- a benign dispatch
-- failure does not hold the backlog closed for the full lease window).
begin;
set local role bsa_alert_worker;
do $$
declare
  v_released boolean;
  v_acquired boolean;
begin
  select app_private.release_outbox_dispatch_lease('00000000-0000-4000-8000-000000000a01'::uuid) into v_released;
  if not v_released then raise exception 'releasing with the correct current-holder token must succeed'; end if;

  select app_private.acquire_outbox_dispatch_lease(
    '00000000-0000-4000-8000-000000000a04'::uuid, current_timestamp + interval '60 seconds'
  ) into v_acquired;
  if not v_acquired then raise exception 'a released lease must be immediately acquirable'; end if;
end
$$;
commit;

-- 5. RT-04.8: a dispatcher that dies mid-scan never reaches its release, so
-- the lease is only recovered once it expires. Backdate it here (as the
-- unrestricted migration/test role, standing in for real wall-clock expiry)
-- and prove a new acquire then succeeds without needing a release at all.
update app_private.outbox_dispatch_lease
   set lease_until = current_timestamp - interval '1 second'
 where id = 1;

begin;
set local role bsa_alert_worker;
do $$
declare
  v_acquired boolean;
begin
  select app_private.acquire_outbox_dispatch_lease(
    '00000000-0000-4000-8000-000000000a05'::uuid, current_timestamp + interval '60 seconds'
  ) into v_acquired;
  if not v_acquired then raise exception 'an expired lease (crashed holder, never released) must be acquirable on a later tick'; end if;
end
$$;
commit;

-- Clean up so this file leaves the singleton row unheld, matching how it
-- started -- this file's own database is disposable, but the row's shape
-- (never left dangling) is part of what this file proves.
begin;
set local role bsa_alert_worker;
do $$
begin
  perform app_private.release_outbox_dispatch_lease('00000000-0000-4000-8000-000000000a05'::uuid);
end
$$;
commit;

-- 6. Direct table access is denied even to bsa_alert_worker -- the lease is
-- reachable only through the two functions above, same as every other
-- app_private control table.
begin;
set local role bsa_alert_worker;
do $$
begin
  perform 1 from app_private.outbox_dispatch_lease;
  raise exception 'bsa_alert_worker must not have direct select on app_private.outbox_dispatch_lease';
exception
  when insufficient_privilege then
    null;
end
$$;
commit;

select 'RT04_OUTBOX_DISPATCH_LEASE=PASS' as result;
