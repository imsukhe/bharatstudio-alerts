-- PRF-02, §6 module #12: SAFE MODE (migration 0138).
--
-- Authority: bharatstudio-requirements/reviews/
-- 2026-09-16-prf-02-slice-6-owner-decisions.md decision 3. Task record:
-- bharatstudio-requirements/active/tasks/PRF-02-safe-mode.md. Acceptance
-- record: bharatstudio-requirements/tests/TC-PRF-02-safe-mode.md.
--
-- This file owns id block ...5a00-...5aff (recorded in
-- fixtures/00_base_world.sql's ID ALLOCATION REGISTRY). It seeds its OWN
-- channels and queues rather than reusing base_world's ...0011/...0012,
-- because what is under test is the ROUTING of newly created deliveries:
-- reusing a shared channel would let another file's queues or deliveries
-- change the answer, and an assertion another file can move is not an
-- assertion.
--
-- THE TWO CASES THAT MATTER MOST ARE SM.6 AND SM.11.
--
--   SM.6 is the question the brief said matters as much as turning it
--   on: what happens to alerts already held when safe mode is switched
--   OFF. The answer is NOTHING -- they stay held, keep their
--   hold_reason, and are reviewed individually through the existing
--   moderation path. There is no bulk release, by decision, and SM.6 is
--   what makes that a fact rather than a promise.
--
--   SM.11 is the owner's "never automatic" constraint, asserted against
--   the SHIPPED function definitions: no interval, no aggregate, no
--   rate, no threshold token anywhere in the two functions that decide
--   and set safe mode. If someone later adds "turn it on when X exceeds
--   Y", this file goes red before the feature ships.
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------
-- Fixture. Two channels: A (the subject) and B (the control that proves
-- the switch is per-channel). Memberships cover every role this file
-- probes: owner and admin may toggle; viewer may not; and channel B's
-- owner is a non-member of A.
-- ---------------------------------------------------------------------
insert into channels (id, owner_user_id, handle, display_name, accepting_tips, public_config_version, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000005a11', '00000000-0000-4000-8000-000000000001', 'safemode_a', 'Safe Mode A', true, 1, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000005a12', '00000000-0000-4000-8000-000000000002', 'safemode_b', 'Safe Mode B', true, 1, current_timestamp, current_timestamp)
on conflict (id) do nothing;

insert into channel_configs (channel_id, version, values, effective_at, created_at)
values
  ('00000000-0000-4000-8000-000000005a11', 1, '{}'::jsonb, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000005a12', 1, '{}'::jsonb, current_timestamp, current_timestamp)
on conflict (channel_id, version) do nothing;

insert into channel_memberships (channel_id, user_id, role, created_at)
values
  ('00000000-0000-4000-8000-000000005a11', '00000000-0000-4000-8000-000000000001', 'owner', current_timestamp),
  ('00000000-0000-4000-8000-000000005a11', '00000000-0000-4000-8000-000000000003', 'admin', current_timestamp),
  ('00000000-0000-4000-8000-000000005a11', '00000000-0000-4000-8000-000000000006', 'viewer', current_timestamp),
  ('00000000-0000-4000-8000-000000005a12', '00000000-0000-4000-8000-000000000002', 'owner', current_timestamp)
on conflict (channel_id, user_id) do nothing;

insert into alert_queues (id, channel_id, name, is_paused, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000005a21', '00000000-0000-4000-8000-000000005a11', 'A primary', false, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000005a22', '00000000-0000-4000-8000-000000005a12', 'B primary', false, current_timestamp, current_timestamp);

insert into overlay_sessions (id, channel_id, token_fingerprint, expires_at, created_at)
values
  ('00000000-0000-4000-8000-000000005a31', '00000000-0000-4000-8000-000000005a11', 'prf02sm-a-fingerprint', current_timestamp + interval '1 hour', current_timestamp),
  ('00000000-0000-4000-8000-000000005a32', '00000000-0000-4000-8000-000000005a12', 'prf02sm-b-fingerprint', current_timestamp + interval '1 hour', current_timestamp),
  ('00000000-0000-4000-8000-000000005a33', '00000000-0000-4000-8000-000000005a11', 'prf02sm-expired-fingerprint', current_timestamp - interval '1 minute', current_timestamp - interval '2 hours');

-- =====================================================================
-- SM.1 -- SAFE MODE DEFAULTS TO OFF.
--
-- The column is additive and defaulted, so every channel that existed
-- before migration 0138 -- and every channel created after it without
-- mentioning safe mode -- behaves exactly as it did before. Asserted
-- against base_world's channels as well as this file's own, because
-- "existing rows are unaffected" is a claim about rows this file did not
-- write.
-- =====================================================================
do $$
declare off_count integer;
begin
  select count(*) into off_count from public.channels where safe_mode_enabled;
  if off_count <> 0 then raise exception 'no channel may start with safe mode on, found % with it on', off_count; end if;
end
$$;

-- =====================================================================
-- SM.2 -- WITH SAFE MODE OFF, A NEW DELIVERY IS 'ready' WITH NO HOLD
-- REASON. The pre-0138 behaviour, unchanged.
-- =====================================================================
do $$
declare decided text;
begin
  decided := app_private.initial_delivery_status('00000000-0000-4000-8000-000000005a11'::uuid);
  if decided <> 'ready' then raise exception 'with safe mode off the initial status must be ready, got %', decided; end if;
  if app_private.initial_delivery_hold_reason(decided) is not null then
    raise exception 'a ready delivery must carry no hold reason';
  end if;
end
$$;

select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);

select app_private.create_manual_alert(
  '00000000-0000-4000-8000-000000005a41'::uuid,
  '00000000-0000-4000-8000-000000005a51'::uuid,
  '00000000-0000-4000-8000-000000005a11'::uuid,
  '00000000-0000-4000-8000-000000000001'::uuid,
  'trace-prf02sm-open-1',
  1,
  jsonb_build_object('message', 'synthetic', 'queueIds', jsonb_build_array('00000000-0000-4000-8000-000000005a21'))
);

do $$
declare row_status text; row_reason text;
begin
  select status, hold_reason into row_status, row_reason
    from public.event_outbox_deliveries where event_id = '00000000-0000-4000-8000-000000005a41';
  if row_status <> 'ready' then raise exception 'safe mode off: a new delivery must be ready, got %', row_status; end if;
  if row_reason is not null then raise exception 'safe mode off: a new delivery must carry no hold reason, got %', row_reason; end if;
end
$$;

-- =====================================================================
-- SM.3 -- WITH SAFE MODE ON, A NEW DELIVERY IS 'held' WITH THE EXISTING
-- 'moderation' HOLD REASON.
--
-- 'moderation' is 0062's EXISTING reason, not a new one. That is what
-- makes SM.7 below work with no change to apply_moderation_action at
-- all: the held path is reused, not duplicated.
-- =====================================================================
do $$
declare enabled boolean;
begin
  enabled := app_private.set_channel_safe_mode(
    '00000000-0000-4000-8000-000000005a11'::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid,
    true);
  if enabled is not true then raise exception 'set_channel_safe_mode(true) must return the new state, got %', enabled; end if;
end
$$;

do $$
declare decided text;
begin
  decided := app_private.initial_delivery_status('00000000-0000-4000-8000-000000005a11'::uuid);
  if decided <> 'held' then raise exception 'with safe mode on the initial status must be held, got %', decided; end if;
  if app_private.initial_delivery_hold_reason(decided) <> 'moderation' then
    raise exception 'a safe-mode hold must reuse the existing ''moderation'' reason, got %', app_private.initial_delivery_hold_reason(decided);
  end if;
end
$$;

select app_private.create_manual_alert(
  '00000000-0000-4000-8000-000000005a42'::uuid,
  '00000000-0000-4000-8000-000000005a52'::uuid,
  '00000000-0000-4000-8000-000000005a11'::uuid,
  '00000000-0000-4000-8000-000000000001'::uuid,
  'trace-prf02sm-held-1',
  1,
  jsonb_build_object('message', 'synthetic', 'queueIds', jsonb_build_array('00000000-0000-4000-8000-000000005a21'))
);

select app_private.create_manual_alert(
  '00000000-0000-4000-8000-000000005a43'::uuid,
  '00000000-0000-4000-8000-000000005a53'::uuid,
  '00000000-0000-4000-8000-000000005a11'::uuid,
  '00000000-0000-4000-8000-000000000001'::uuid,
  'trace-prf02sm-held-2',
  1,
  jsonb_build_object('message', 'synthetic', 'queueIds', jsonb_build_array('00000000-0000-4000-8000-000000005a21'))
);

do $$
declare held_rows integer;
begin
  select count(*) into held_rows
    from public.event_outbox_deliveries
   where event_id in ('00000000-0000-4000-8000-000000005a42', '00000000-0000-4000-8000-000000005a43')
     and status = 'held' and hold_reason = 'moderation';
  if held_rows <> 2 then raise exception 'safe mode on: both new deliveries must be held with hold_reason moderation, got %', held_rows; end if;
end
$$;

-- The delivery created BEFORE the switch was thrown is untouched. Safe
-- mode routes new deliveries; it never reaches back.
do $$
declare row_status text;
begin
  select status into row_status from public.event_outbox_deliveries where event_id = '00000000-0000-4000-8000-000000005a41';
  if row_status <> 'ready' then raise exception 'turning safe mode ON must not change a delivery that already existed, got %', row_status; end if;
end
$$;

-- =====================================================================
-- SM.4 -- SAFE MODE IS PER CHANNEL. A is on; B, whose switch was never
-- touched, still routes to ready.
-- =====================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000000002', false);

select app_private.create_manual_alert(
  '00000000-0000-4000-8000-000000005a44'::uuid,
  '00000000-0000-4000-8000-000000005a54'::uuid,
  '00000000-0000-4000-8000-000000005a12'::uuid,
  '00000000-0000-4000-8000-000000000002'::uuid,
  'trace-prf02sm-b-1',
  1,
  jsonb_build_object('message', 'synthetic', 'queueIds', jsonb_build_array('00000000-0000-4000-8000-000000005a22'))
);

do $$
declare row_status text; a_decided text; b_decided text;
begin
  select status into row_status from public.event_outbox_deliveries where event_id = '00000000-0000-4000-8000-000000005a44';
  if row_status <> 'ready' then raise exception 'channel B''s safe mode is off, so its delivery must be ready, got %', row_status; end if;
  a_decided := app_private.initial_delivery_status('00000000-0000-4000-8000-000000005a11'::uuid);
  b_decided := app_private.initial_delivery_status('00000000-0000-4000-8000-000000005a12'::uuid);
  if a_decided <> 'held' or b_decided <> 'ready' then
    raise exception 'safe mode must be per channel: A=% B=%', a_decided, b_decided;
  end if;
end
$$;

select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);

-- =====================================================================
-- SM.5 -- A SAFE-MODE-HELD DELIVERY IS NOT DISPATCHABLE.
--
-- No dispatcher change was made by 0138, and this is why: 'held' is
-- already excluded from list_ready_event_deliveries and
-- claim_event_delivery (0062). Asserted rather than assumed -- if a
-- future change admitted 'held' to either, safe mode would silently stop
-- holding anything and this case is what would catch it.
-- =====================================================================
do $$
declare listed integer; claimed integer; target record;
begin
  select count(*) into listed
    from app_private.list_ready_event_deliveries(500) ready
   where ready.event_id in ('00000000-0000-4000-8000-000000005a42', '00000000-0000-4000-8000-000000005a43');
  if listed <> 0 then raise exception 'a safe-mode-held delivery must never be listed as ready for dispatch, got %', listed; end if;

  select id, event_id, outbox_id, attempt_count, state_version into target
    from public.event_outbox_deliveries where event_id = '00000000-0000-4000-8000-000000005a42';

  select count(*) into claimed
    from app_private.claim_event_delivery(
      target.id, target.event_id, target.outbox_id,
      target.attempt_count + 1, target.state_version,
      gen_random_uuid(), current_timestamp + interval '1 minute');
  if claimed <> 0 then raise exception 'a safe-mode-held delivery must never be claimable, got % claimed rows', claimed; end if;
end
$$;

-- The B delivery, created with safe mode off, IS dispatchable -- so
-- SM.5's zero is a real exclusion and not an artefact of the fixture.
do $$
declare listed integer;
begin
  select count(*) into listed
    from app_private.list_ready_event_deliveries(500) ready
   where ready.event_id = '00000000-0000-4000-8000-000000005a44';
  if listed <> 1 then raise exception 'a delivery created with safe mode OFF must still be dispatchable: expected 1, got %', listed; end if;
end
$$;

-- =====================================================================
-- SM.6 -- TURNING SAFE MODE OFF RELEASES NOTHING.
--
-- THIS IS THE ANSWER TO "what happens to alerts already held when safe
-- mode is switched off", and it is deliberate: they stay held, keep
-- hold_reason = 'moderation', do not move their state_version, and are
-- reviewed one at a time through the existing moderation path. No bulk
-- release exists, because none has been decided -- auto-releasing a
-- backlog on a switch flip would fire an unknown number of unreviewed
-- alerts onto a live broadcast, irreversibly.
--
-- What DOES change is the routing of the next new delivery.
-- =====================================================================
do $$
declare versions_before bigint;
begin
  select sum(state_version) into versions_before
    from public.event_outbox_deliveries
   where event_id in ('00000000-0000-4000-8000-000000005a42', '00000000-0000-4000-8000-000000005a43');
  perform set_config('prf02sm.versions_before', versions_before::text, false);
end
$$;

do $$
declare enabled boolean;
begin
  enabled := app_private.set_channel_safe_mode(
    '00000000-0000-4000-8000-000000005a11'::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid,
    false);
  if enabled is not false then raise exception 'set_channel_safe_mode(false) must return the new state, got %', enabled; end if;
end
$$;

do $$
declare still_held integer; versions_after bigint;
begin
  select count(*) into still_held
    from public.event_outbox_deliveries
   where event_id in ('00000000-0000-4000-8000-000000005a42', '00000000-0000-4000-8000-000000005a43')
     and status = 'held' and hold_reason = 'moderation';
  if still_held <> 2 then
    raise exception 'turning safe mode OFF must release NOTHING: both deliveries must still be held with hold_reason moderation, got %', still_held;
  end if;

  select sum(state_version) into versions_after
    from public.event_outbox_deliveries
   where event_id in ('00000000-0000-4000-8000-000000005a42', '00000000-0000-4000-8000-000000005a43');
  if versions_after <> current_setting('prf02sm.versions_before')::bigint then
    raise exception 'turning safe mode off must not touch a held delivery at all -- state_version moved from % to %', current_setting('prf02sm.versions_before'), versions_after;
  end if;
end
$$;

-- The next NEW delivery is ready again. That is the whole of what the
-- switch changed.
select app_private.create_manual_alert(
  '00000000-0000-4000-8000-000000005a45'::uuid,
  '00000000-0000-4000-8000-000000005a55'::uuid,
  '00000000-0000-4000-8000-000000005a11'::uuid,
  '00000000-0000-4000-8000-000000000001'::uuid,
  'trace-prf02sm-open-2',
  1,
  jsonb_build_object('message', 'synthetic', 'queueIds', jsonb_build_array('00000000-0000-4000-8000-000000005a21'))
);

do $$
declare row_status text;
begin
  select status into row_status from public.event_outbox_deliveries where event_id = '00000000-0000-4000-8000-000000005a45';
  if row_status <> 'ready' then raise exception 'after safe mode is switched off the next NEW delivery must be ready, got %', row_status; end if;
end
$$;

-- =====================================================================
-- SM.7 -- THE EXISTING PER-EVENT MODERATION PATH STILL RELEASES A
-- SAFE-MODE HOLD, WITH NO CHANGE TO apply_moderation_action.
--
-- This is the reuse D3 bought: because a safe-mode hold carries the
-- existing hold_reason = 'moderation', 0062's approve branch already
-- matches it. One delivery is approved; the OTHER stays held, which is
-- what "reviewed individually" means and what proves no bulk release
-- happened.
-- =====================================================================
select app_private.apply_moderation_action(
  '00000000-0000-4000-8000-000000005a42'::uuid,
  '00000000-0000-4000-8000-000000005a11'::uuid,
  '00000000-0000-4000-8000-000000000001'::uuid,
  'approve',
  null);

do $$
declare approved_status text; approved_reason text; other_status text;
begin
  select status, hold_reason into approved_status, approved_reason
    from public.event_outbox_deliveries where event_id = '00000000-0000-4000-8000-000000005a42';
  if approved_status <> 'ready' or approved_reason is not null then
    raise exception 'the existing approve action must release a safe-mode hold: status=% hold_reason=%', approved_status, approved_reason;
  end if;

  select status into other_status
    from public.event_outbox_deliveries where event_id = '00000000-0000-4000-8000-000000005a43';
  if other_status <> 'held' then
    raise exception 'approving one held delivery must not release another -- held alerts are reviewed individually, got % for the second', other_status;
  end if;
end
$$;

-- =====================================================================
-- SM.8 -- THE WRITE IS ROLE-GATED, AND A REFUSAL CHANGES NOTHING.
--
-- owner and admin may toggle. A viewer-role member may not, a
-- non-member may not, and an actor whose target_user_id does not match
-- the session identity may not. Every refusal is 42501 and leaves the
-- stored value exactly as it was.
-- =====================================================================
do $$
declare before_value boolean; after_value boolean; failed boolean;
begin
  select safe_mode_enabled into before_value from public.channels where id = '00000000-0000-4000-8000-000000005a11';

  -- Admin may.
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000003', false);
  if app_private.set_channel_safe_mode('00000000-0000-4000-8000-000000005a11'::uuid, '00000000-0000-4000-8000-000000000003'::uuid, true) is not true then
    raise exception 'an admin must be able to turn safe mode on';
  end if;
  perform app_private.set_channel_safe_mode('00000000-0000-4000-8000-000000005a11'::uuid, '00000000-0000-4000-8000-000000000003'::uuid, before_value);

  -- A viewer-role member may not.
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000006', false);
  failed := false;
  begin
    perform app_private.set_channel_safe_mode('00000000-0000-4000-8000-000000005a11'::uuid, '00000000-0000-4000-8000-000000000006'::uuid, true);
  exception when insufficient_privilege then failed := true;
  end;
  if not failed then raise exception 'a viewer-role member must not be able to change safe mode'; end if;

  -- A non-member may not.
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000002', false);
  failed := false;
  begin
    perform app_private.set_channel_safe_mode('00000000-0000-4000-8000-000000005a11'::uuid, '00000000-0000-4000-8000-000000000002'::uuid, true);
  exception when insufficient_privilege then failed := true;
  end;
  if not failed then raise exception 'a non-member must not be able to change another channel''s safe mode'; end if;

  -- An actor id that does not match the session identity may not, even
  -- when that actor WOULD be allowed.
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000006', false);
  failed := false;
  begin
    perform app_private.set_channel_safe_mode('00000000-0000-4000-8000-000000005a11'::uuid, '00000000-0000-4000-8000-000000000001'::uuid, true);
  exception when insufficient_privilege then failed := true;
  end;
  if not failed then raise exception 'an actor id that does not match the session identity must be refused'; end if;

  select safe_mode_enabled into after_value from public.channels where id = '00000000-0000-4000-8000-000000005a11';
  if after_value is distinct from before_value then
    raise exception 'a refused safe-mode change must leave the stored value untouched: % -> %', before_value, after_value;
  end if;
end
$$;

select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);

-- =====================================================================
-- SM.9 -- THE SWITCH IS IDEMPOTENT, AND THE READ AGREES WITH IT.
--
-- set takes the VALUE, not a toggle, so setting what is already set is a
-- no-op rather than a flip. A stale dashboard tab cannot invert safe
-- mode by asking for "the other one".
-- =====================================================================
do $$
declare read_value boolean;
begin
  perform app_private.set_channel_safe_mode('00000000-0000-4000-8000-000000005a11'::uuid, '00000000-0000-4000-8000-000000000001'::uuid, true);
  perform app_private.set_channel_safe_mode('00000000-0000-4000-8000-000000005a11'::uuid, '00000000-0000-4000-8000-000000000001'::uuid, true);
  select enabled into read_value from app_private.get_channel_safe_mode('00000000-0000-4000-8000-000000005a11'::uuid);
  if read_value is not true then raise exception 'setting true twice must leave safe mode on, got %', read_value; end if;

  perform app_private.set_channel_safe_mode('00000000-0000-4000-8000-000000005a11'::uuid, '00000000-0000-4000-8000-000000000001'::uuid, false);
  perform app_private.set_channel_safe_mode('00000000-0000-4000-8000-000000005a11'::uuid, '00000000-0000-4000-8000-000000000001'::uuid, false);
  select enabled into read_value from app_private.get_channel_safe_mode('00000000-0000-4000-8000-000000005a11'::uuid);
  if read_value is not false then raise exception 'setting false twice must leave safe mode off, got %', read_value; end if;
end
$$;

-- The read is role-gated the same way, and answers ZERO ROWS -- not a
-- row reading false -- for a caller who may not see it. A non-member and
-- a non-existent channel are the same answer, so the route can map both
-- to 404 without confirming the channel exists.
do $$
declare row_count integer;
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000006', false);
  select count(*) into row_count from app_private.get_channel_safe_mode('00000000-0000-4000-8000-000000005a11'::uuid);
  if row_count <> 0 then raise exception 'a viewer-role member must read zero rows, got %', row_count; end if;

  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000002', false);
  select count(*) into row_count from app_private.get_channel_safe_mode('00000000-0000-4000-8000-000000005a11'::uuid);
  if row_count <> 0 then raise exception 'a non-member must read zero rows, got %', row_count; end if;

  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);
  select count(*) into row_count from app_private.get_channel_safe_mode('00000000-0000-4000-8000-0000000055ff'::uuid);
  if row_count <> 0 then raise exception 'a channel that does not exist must read zero rows, got %', row_count; end if;

  select count(*) into row_count from app_private.get_channel_safe_mode('00000000-0000-4000-8000-000000005a11'::uuid);
  if row_count <> 1 then raise exception 'the owner must read exactly one row, got %', row_count; end if;
end
$$;

-- =====================================================================
-- SM.10 -- SAFE MODE IS NEVER TIER-GATED (§12.6).
--
-- The channel is put on the FREE entitlement tier and the toggle must
-- still work. Storing, viewing and changing a durable creator record is
-- available at every tier; §30.3's module cap governs only whether the
-- Canvas RENDERS the Moderator Status Card.
-- =====================================================================
insert into channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at)
values ('00000000-0000-4000-8000-000000005a11', 1, 'free', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp)
on conflict do nothing;

do $$
declare enabled boolean; tier text;
begin
  select app_private.current_channel_tier('00000000-0000-4000-8000-000000005a11'::uuid) into tier;
  enabled := app_private.set_channel_safe_mode('00000000-0000-4000-8000-000000005a11'::uuid, '00000000-0000-4000-8000-000000000001'::uuid, true);
  if enabled is not true then
    raise exception 'safe mode must be available at every tier (§12.6); the toggle failed at tier %', tier;
  end if;
  perform app_private.set_channel_safe_mode('00000000-0000-4000-8000-000000005a11'::uuid, '00000000-0000-4000-8000-000000000001'::uuid, false);
end
$$;

-- =====================================================================
-- SM.11 -- SAFE MODE IS NEVER AUTOMATIC, PROVEN AGAINST THE SHIPPED
-- FUNCTION DEFINITIONS.
--
-- Owner decision, 2026-09-16: no spike detection, no rejection-rate
-- heuristic, no signal of any kind engages safe mode. A creator turns it
-- on and off. So the two functions that DECIDE the status and SET the
-- switch must contain no threshold, no window, no interval, no rate and
-- no aggregate -- because any of those would be the machinery of an
-- automatic trigger arriving without a decision.
--
-- Asserted against pg_get_functiondef, which is what the database
-- actually holds, rather than against a comment that could drift.
-- =====================================================================
do $$
declare definition text; fn text; token text;
begin
  foreach fn in array array['initial_delivery_status', 'set_channel_safe_mode']
  loop
    select pg_catalog.pg_get_functiondef(p.oid)
      into definition
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app_private' and p.proname = fn;

    if definition is null then raise exception 'app_private.% does not exist', fn; end if;

    foreach token in array array['interval', 'count(', 'sum(', 'avg(', 'rate', 'spike', 'threshold', 'window', 'percent']
    loop
      if position(token in lower(definition)) > 0 then
        raise exception 'app_private.% contains "%" -- safe mode is NEVER automatic (owner decision, 2026-09-16). No threshold, window, rate or aggregate may decide when it engages; if one is needed that is a new owner decision, not a constant chosen here', fn, token;
      end if;
    end loop;

    if position('is_paused' in lower(definition)) > 0 then
      raise exception 'app_private.% references the queue-paused flag -- safe mode is NOT alert_queues.is_paused', fn;
    end if;
  end loop;
end
$$;

-- =====================================================================
-- SM.12 -- THE OVERLAY READ CARRIES THE FLAG, SCOPED BY THE SESSION.
-- =====================================================================
do $$
declare a_safe boolean; b_safe boolean; a_held bigint;
begin
  perform app_private.set_channel_safe_mode('00000000-0000-4000-8000-000000005a11'::uuid, '00000000-0000-4000-8000-000000000001'::uuid, true);

  select safe_mode, held_count into a_safe, a_held
    from app_private.list_overlay_moderator_status('00000000-0000-4000-8000-000000005a31'::uuid, 'prf02sm-a-fingerprint');
  if a_safe is not true then raise exception 'channel A''s overlay session must read safe mode on, got %', a_safe; end if;
  if a_held <> 1 then raise exception 'channel A has exactly one still-held delivery at this point, got %', a_held; end if;

  select safe_mode into b_safe
    from app_private.list_overlay_moderator_status('00000000-0000-4000-8000-000000005a32'::uuid, 'prf02sm-b-fingerprint');
  if b_safe is not false then raise exception 'channel B''s overlay session must read its OWN safe mode (off), never A''s, got %', b_safe; end if;
end
$$;

-- =====================================================================
-- SM.13 -- AN UNRECOGNISED SESSION STILL RETURNS ZERO ROWS, NOT A ROW
-- READING false.
--
-- Slice 5 made this distinction load-bearing and safe mode must not
-- collapse it: zero rows means "not authorised / no answer" and the card
-- renders nothing without claiming anything; a row reading false is a
-- real answer meaning "safe mode is off". A bad token must never be able
-- to produce the second.
-- =====================================================================
do $$
declare row_count integer;
begin
  select count(*) into row_count from app_private.list_overlay_moderator_status('00000000-0000-4000-8000-000000005a31'::uuid, 'prf02sm-wrong-fingerprint');
  if row_count <> 0 then raise exception 'a wrong token fingerprint must return zero rows, got %', row_count; end if;

  select count(*) into row_count from app_private.list_overlay_moderator_status('00000000-0000-4000-8000-000000005a32'::uuid, 'prf02sm-a-fingerprint');
  if row_count <> 0 then raise exception 'a fingerprint from another channel''s session must return zero rows, got %', row_count; end if;

  select count(*) into row_count from app_private.list_overlay_moderator_status('00000000-0000-4000-8000-000000005a33'::uuid, 'prf02sm-expired-fingerprint');
  if row_count <> 0 then raise exception 'an expired overlay session must return zero rows, got %', row_count; end if;
end
$$;

select 'prf02_safe_mode.sql: all assertions passed' as result;
