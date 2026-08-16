-- L03/L04 acceptance: downgrade enforcement pauses a channel's excess
-- queues, oldest-first retention, only ever via the real webhook-confirmed
-- path (apply_channel_subscription_state) — never deletes a queue, never
-- re-pauses/relabels a queue a creator paused manually, and is idempotent.
-- Synthetic identifiers only; no provider or production data is permitted.

\set ON_ERROR_STOP on

do $$
declare
  free_queue_count text;
begin
  if app_private.tier_queue_count('free') <> 1
     or app_private.tier_queue_count('pro') <> 3
     or app_private.tier_queue_count('creator') <> 5
     or app_private.tier_queue_count('studio') <> 10 then
    raise exception 'tier_queue_count does not match the approved entitlement values addendum';
  end if;
  begin
    perform app_private.tier_queue_count('enterprise');
    raise exception 'tier_queue_count accepted an unapproved tier';
  exception when sqlstate '22023' then
    null;
  end;
end
$$;

insert into app_users (id, external_subject, display_name, created_at, updated_at)
values ('00000000-0000-4000-8000-000000000601', 'google-l04-downgrade', 'Synthetic Downgrade Owner', current_timestamp, current_timestamp);

begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000000601', true);
select * from app_private.create_channel(
  '00000000-0000-4000-8000-000000000014',
  '00000000-0000-4000-8000-000000000601', 'downgrade_enforcement_test', 'Downgrade Enforcement Test'
);
commit;

do $$
declare
  seeded_queue_count text;
begin
  select values ->> 'queueCount' into seeded_queue_count
    from channel_entitlement_versions
   where channel_id = '00000000-0000-4000-8000-000000000014'
   order by version desc
   limit 1;
  if seeded_queue_count <> '1' then
    raise exception 'new channel free entitlement did not seed queueCount=1: %', seeded_queue_count;
  end if;
end
$$;

-- Two more queues, created oldest-first alongside the auto-provisioned
-- default queue, simulating a creator who was on a higher tier. Direct
-- inserts (not through the entitlement-checked creator API) match every
-- other fixture-setup insert in this test suite.
insert into alert_queues (id, channel_id, name, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000000611', '00000000-0000-4000-8000-000000000014', 'Second queue', current_timestamp + interval '1 minute', current_timestamp + interval '1 minute'),
  ('00000000-0000-4000-8000-000000000612', '00000000-0000-4000-8000-000000000014', 'Third queue', current_timestamp + interval '2 minutes', current_timestamp + interval '2 minutes');

-- A creator's own manual pause on the newest queue, before any downgrade —
-- must never be relabelled or unpaused by enforcement.
begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000000601', true);
update alert_queues
   set is_paused = true, paused_reason = 'manual', paused_at = current_timestamp, updated_by = 'user:00000000-0000-4000-8000-000000000601', updated_at = current_timestamp
 where id = '00000000-0000-4000-8000-000000000612';
commit;

do $$
declare
  state_result text;
  published_tier text;
  published_queue_count text;
  open_active_count integer;
  found_reason text;
begin
  -- Upgrading to creator (queueCount=5) must publish the value and run
  -- enforcement as a no-op: 2 active queues (the manually-paused one is
  -- excluded from the active pool) is well under the limit.
  set role bsa_payment;
  select result into state_result
    from app_private.apply_channel_subscription_state(
      '00000000-0000-4000-8000-000000000014', 'test', 'acct_synthetic_platform',
      'sub_synthetic_downgrade_1', 'creator', 'monthly', 39900, 'active', true,
      '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z',
      '2026-01-01T00:00:00Z'
    );
  reset role;
  if state_result <> 'created' then
    raise exception 'creator-tier activation did not create a subscription row: %', state_result;
  end if;

  select values ->> 'queueCount' into published_queue_count
    from channel_entitlement_versions
   where channel_id = '00000000-0000-4000-8000-000000000014'
   order by version desc
   limit 1;
  if published_queue_count <> '5' then
    raise exception 'creator-tier entitlement did not publish queueCount=5: %', published_queue_count;
  end if;

  select count(*) into open_active_count
    from alert_queues
   where channel_id = '00000000-0000-4000-8000-000000000014' and closed_at is null and is_paused = false;
  if open_active_count <> 2 then
    raise exception 'creator-tier upgrade incorrectly changed the active queue count: %', open_active_count;
  end if;

  -- Cancellation, confirmed by the provider, must revert the entitlement to
  -- free (queueCount=1) and pause every active queue beyond that limit,
  -- newest-first — the manually-paused queue is left completely alone.
  set role bsa_payment;
  perform app_private.apply_channel_subscription_state(
    '00000000-0000-4000-8000-000000000014', 'test', 'acct_synthetic_platform',
    'sub_synthetic_downgrade_1', 'creator', 'monthly', 39900, 'cancelled', false,
    '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', null,
    '2026-01-15T00:00:00Z'
  );
  reset role;

  select tier, values ->> 'queueCount' into published_tier, published_queue_count
    from channel_entitlement_versions
   where channel_id = '00000000-0000-4000-8000-000000000014'
   order by version desc
   limit 1;
  if published_tier <> 'free' or published_queue_count <> '1' then
    raise exception 'cancellation did not revert entitlement to free/queueCount=1: tier %, queueCount %', published_tier, published_queue_count;
  end if;

  if (select count(*) from alert_queues where channel_id = '00000000-0000-4000-8000-000000000014' and closed_at is null and is_paused = false) <> 1 then
    raise exception 'downgrade enforcement left more than one active queue for the free tier';
  end if;

  -- The oldest queue (the auto-provisioned default) must be the one kept.
  if (select is_paused from alert_queues where channel_id = '00000000-0000-4000-8000-000000000014' and name = 'Main alerts') <> false then
    raise exception 'downgrade enforcement paused the oldest (default) queue instead of retaining it';
  end if;

  -- The second queue (newest of the two that were active) must be the one
  -- system-paused, with the machine-readable reason set.
  select paused_reason into found_reason
    from alert_queues where id = '00000000-0000-4000-8000-000000000611';
  if (select is_paused from alert_queues where id = '00000000-0000-4000-8000-000000000611') <> true
     or found_reason <> 'tier_downgrade' then
    raise exception 'excess active queue was not paused with reason tier_downgrade: %', found_reason;
  end if;

  -- The manually-paused queue must be untouched: still paused, still
  -- reason 'manual', never relabelled by the downgrade pass.
  select paused_reason into found_reason
    from alert_queues where id = '00000000-0000-4000-8000-000000000612';
  if found_reason <> 'manual' then
    raise exception 'manual pause reason was overwritten by downgrade enforcement: %', found_reason;
  end if;

  -- Idempotency: running enforcement again against the same (already
  -- enforced) state must not change anything further.
  set role bsa_payment;
  perform app_private.enforce_queue_count_entitlement('00000000-0000-4000-8000-000000000014', 'free');
  reset role;
  if (select count(*) from alert_queues where channel_id = '00000000-0000-4000-8000-000000000014' and closed_at is null and is_paused = false) <> 1 then
    raise exception 'repeated enforcement pass changed the active queue count';
  end if;
exception when others then
  reset role;
  raise;
end
$$;

-- The pause/resume consistency guard is a real database constraint, not
-- just application discipline: unpausing a queue without also clearing its
-- paused_reason/paused_at must be rejected.
do $$
begin
  set role bsa_app;
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000601', true);
  begin
    update alert_queues
       set is_paused = false
     where id = '00000000-0000-4000-8000-000000000611';
    reset role;
    raise exception 'unpausing without clearing paused_reason/paused_at was incorrectly accepted';
  exception when check_violation then
    reset role;
  end;
end
$$;

select 'L04_DOWNGRADE_ENFORCEMENT=PASS' as result;
