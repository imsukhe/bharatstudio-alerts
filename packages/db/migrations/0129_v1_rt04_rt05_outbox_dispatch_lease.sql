-- RT-04/RT-05 (§19.0): the webhook does one atomic commit then 2xx; the
-- outbox dispatcher (services/alert-worker-go's pump, invoked both by the
-- post-commit fire-and-forget wake-up and by the scheduled
-- "outbox-recovery" cron, RT-08) is the only scanner left. RT-05's own
-- defect: app_private.list_ready_event_deliveries (0063) is `stable` -- a
-- pure read with no leasing -- so concurrent pump runs (a burst of webhook
-- wake-ups, or a wake-up overlapping the scheduled tick) list and attempt to
-- enqueue the same backlog repeatedly. Only deterministic Cloud Task names
-- save correctness today; this migration removes the redundant work itself.
--
-- This is a coarse, single-row mutual-exclusion lease over one dispatch run
-- at a time -- not a second per-delivery lease mechanism. It deliberately
-- does NOT touch event_outbox_deliveries.lease_token/lease_until: that pair
-- already means "this specific delivery is currently claimed for
-- processing" (app_private.claim_event_delivery, 0004/0022/0063), set at
-- Cloud-Task-fire time, well after a pump's scan step. Reusing that same
-- per-delivery field as a scan-time lease would block the real claim from
-- succeeding until the scan lease expired -- turning a fire-and-forget,
-- near-immediate dispatch into one that waits out the scan lease on every
-- normal delivery, not just a missed one. A single dispatcher-run lease,
-- using the identical token+expiry discipline at a coarser grain, gives the
-- same safety (no two dispatch runs enqueue the same backlog concurrently)
-- without that latency regression.
--
-- Lease duration is not a new number: the "outbox-recovery" schedule
-- (bharatstudio-crons/schedules/v1.json) already carries timeoutSeconds 60
-- for exactly this endpoint, so a dispatch run is already expected to
-- complete, or be considered stuck, within 60 seconds. Using the same 60s
-- as the lease TTL means a dispatcher that dies mid-scan (crashes before
-- its deferred release runs) is picked up again well before the next
-- scheduled tick two minutes later (RT-04.8) -- no new number is invented.
-- The scan batch size is unchanged: list_ready_event_deliveries already
-- caps at 500 (0063) and this migration does not touch that function.
--
-- Depends on 0001-0128. Modifies no existing migration file; this is a new
-- forward migration only. Its own rollback, should one ever be needed, is a
-- new forward migration dropping this table/these functions -- never an
-- edit of this file.

create table if not exists app_private.outbox_dispatch_lease (
  id smallint primary key default 1,
  lease_token uuid,
  lease_until timestamptz,
  updated_at timestamptz not null default current_timestamp,
  constraint outbox_dispatch_lease_singleton check (id = 1)
);

insert into app_private.outbox_dispatch_lease (id)
values (1)
on conflict (id) do nothing;

alter table app_private.outbox_dispatch_lease enable row level security;
revoke all on app_private.outbox_dispatch_lease from public;
revoke all on app_private.outbox_dispatch_lease from bsa_app;
revoke all on app_private.outbox_dispatch_lease from bsa_alert_worker;

-- Acquires the single dispatch-run lease. Succeeds only when the lease is
-- currently unheld (never acquired) or its previous holder's lease has
-- already expired -- the exact "unleased or expired" discipline
-- claim_event_delivery already uses, applied to one control row instead of
-- one row per delivery.
create or replace function app_private.acquire_outbox_dispatch_lease(
  target_lease_token uuid,
  target_lease_until timestamptz
)
returns boolean
language sql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
  with acquired as (
    update app_private.outbox_dispatch_lease
       set lease_token = target_lease_token,
           lease_until = target_lease_until,
           updated_at = current_timestamp
     where id = 1
       and target_lease_token is not null
       and target_lease_until > current_timestamp
       and (lease_until is null or lease_until <= current_timestamp)
    returning id
  )
  select exists (select 1 from acquired)
$$;

-- Releases the lease early, on a graceful (non-crash) return from a
-- dispatch run, so a benign failure does not hold the backlog closed for
-- the full lease window. Only the current holder (matching lease_token) can
-- release it; a lease that already expired and was reacquired by a later
-- run is left alone.
create or replace function app_private.release_outbox_dispatch_lease(
  target_lease_token uuid
)
returns boolean
language sql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
  with released as (
    update app_private.outbox_dispatch_lease
       set lease_token = null,
           lease_until = null,
           updated_at = current_timestamp
     where id = 1
       and target_lease_token is not null
       and lease_token = target_lease_token
    returning id
  )
  select exists (select 1 from released)
$$;

revoke execute on function app_private.acquire_outbox_dispatch_lease(uuid, timestamptz) from public;
revoke execute on function app_private.release_outbox_dispatch_lease(uuid) from public;
grant execute on function app_private.acquire_outbox_dispatch_lease(uuid, timestamptz) to bsa_alert_worker;
grant execute on function app_private.release_outbox_dispatch_lease(uuid) to bsa_alert_worker;
