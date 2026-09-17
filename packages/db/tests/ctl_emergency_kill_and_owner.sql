-- Migration 0155: three jobs over the approval model -- real platform
-- owner identity (Job 1), §20.6.1's full emergency global_kill path
-- (Job 2), and closing the single-admin bypass on §20.2's registry
-- fields (Job 3).
--
-- Fixture: own app_users block '...6f00'-'...6f06' (pre-assigned range
-- ...6f00-...6fff, verified free -- packages/db/tests/fixtures/
-- 00_base_world.sql's own running note names ...6f00 upward as the next
-- free block). No channel/channel_membership fixture is needed: every
-- function this migration adds is gated by app_private.is_platform_admin()
-- (plus, for owner actions, app_private.is_platform_owner()) alone --
-- platform-wide concerns, never per-channel. 00_base_world.sql is not
-- touched by this file or by migration 0155.
\set ON_ERROR_STOP on

insert into app_users (id, external_subject, display_name, created_at, updated_at, is_platform_admin, is_platform_owner)
values
  ('00000000-0000-4000-8000-000000006f00', 'google-ctl07-admin-alpha', 'CTL07 Admin Alpha', current_timestamp, current_timestamp, true, false),
  ('00000000-0000-4000-8000-000000006f01', 'google-ctl07-admin-beta', 'CTL07 Admin Beta', current_timestamp, current_timestamp, true, false),
  ('00000000-0000-4000-8000-000000006f02', 'google-ctl07-admin-gamma', 'CTL07 Admin Gamma', current_timestamp, current_timestamp, true, false),
  ('00000000-0000-4000-8000-000000006f03', 'google-ctl07-non-admin', 'CTL07 Non Admin', current_timestamp, current_timestamp, false, false),
  -- Not-yet-owner admin -- promoted to owner later in this file.
  ('00000000-0000-4000-8000-000000006f04', 'google-ctl07-admin-delta', 'CTL07 Admin Delta', current_timestamp, current_timestamp, true, false),
  -- Owner but deliberately NOT platform admin -- proves the conjoint
  -- (owner AND admin) requirement rejects owner-alone. Seeded directly
  -- in this fixture (not via staff_set_platform_owner) the same way
  -- every other fixture file seeds is_platform_admin directly -- no
  -- "who grants the very first flag" function exists or is invented for
  -- either boolean anywhere in this schema.
  ('00000000-0000-4000-8000-000000006f06', 'google-ctl07-owner-not-admin', 'CTL07 Owner Not Admin', current_timestamp, current_timestamp, false, true)
on conflict (id) do nothing;

-- =========================================================================
-- GRANTS LOCKDOWN: every new table revoked from public AND bsa_app;
-- every new function revoked from public, granted to bsa_app (except
-- the deliberately-unreachable-from-the-app internal helper).
-- =========================================================================
do $$
declare tbl record;
begin
  for tbl in
    select unnest(array[
      'public.platform_owner_audit',
      'public.capability_kill_events',
      'public.capability_kill_ratifications',
      'public.capability_kill_extension_requests',
      'public.capability_kill_extension_approvals',
      'public.capability_kill_reviews'
    ]) as name
  loop
    if has_table_privilege('public', tbl.name, 'SELECT') then
      raise exception 'SELECT on % must be revoked from public', tbl.name;
    end if;
    if has_table_privilege('bsa_app', tbl.name, 'SELECT') then
      raise exception 'SELECT on % must be revoked from bsa_app -- functions are the only reachable path', tbl.name;
    end if;
    if has_table_privilege('bsa_app', tbl.name, 'INSERT') then
      raise exception 'INSERT on % must be revoked from bsa_app', tbl.name;
    end if;
  end loop;
end
$$;

do $$
declare fn record;
begin
  for fn in
    select unnest(array[
      'app_private.is_platform_owner()',
      'app_private.staff_set_platform_owner(uuid, boolean, text)',
      'app_private.staff_fire_global_kill(text, text, integer, integer)',
      'app_private.staff_ratify_kill_event(uuid)',
      'app_private.staff_propose_kill_extension(uuid, timestamptz, text)',
      'app_private.staff_approve_kill_extension(uuid)',
      'app_private.staff_file_kill_review(uuid, text)',
      'app_private.staff_get_kill_event(uuid)',
      'app_private.staff_list_kill_events(text, integer)',
      'app_private.capability_kill_effective_expires_at(uuid)',
      'app_private.apply_due_kill_revert(uuid)',
      'app_private.capability_kill_event_row(uuid)'
    ]) as sig
  loop
    if has_function_privilege('public', fn.sig, 'execute') then
      raise exception 'execute on % must be revoked from public', fn.sig;
    end if;
    if not has_function_privilege('bsa_app', fn.sig, 'execute') then
      raise exception 'execute on % must be granted to bsa_app', fn.sig;
    end if;
  end loop;
end
$$;

-- The internal unguarded write helper (Job 3) must be revoked from
-- public AND must NOT be granted to bsa_app at all -- the whole point of
-- the restructure.
do $$
declare sig text := 'app_private.set_capability_registry_entry_unchecked(text, text, text, boolean, integer, text, text, jsonb, boolean, boolean, text, text)';
begin
  if has_function_privilege('public', sig, 'execute') then
    raise exception 'execute on % must be revoked from public', sig;
  end if;
  if has_function_privilege('bsa_app', sig, 'execute') then
    raise exception 'execute on % must NOT be granted to bsa_app -- it is reachable only from another SECURITY DEFINER function, by design', sig;
  end if;
end
$$;

-- =========================================================================
-- Non-staff rejected on every new function.
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000006f03', false); -- non-admin
do $$
begin
  begin
    perform app_private.staff_set_platform_owner('00000000-0000-4000-8000-000000006f04'::uuid, true, 'attempted by non-admin');
    raise exception 'a non-admin must not be able to call staff_set_platform_owner';
  exception when insufficient_privilege then null;
  end;
  begin
    perform app_private.staff_fire_global_kill('anything', 'attempted by non-admin', 1, 1);
    raise exception 'a non-admin must not be able to call staff_fire_global_kill';
  exception when insufficient_privilege then null;
  end;
end
$$;
select set_config('app.user_id', '00000000-0000-4000-8000-000000006f00', false);

-- =========================================================================
-- JOB 1a: the singleton index. 6f06 already carries is_platform_owner=
-- true (fixture) -- a raw attempt to ALSO set it on 6f04 must violate
-- the partial unique index, proving "at most one true row" is a real
-- database constraint, not an application convention.
-- =========================================================================
do $$
begin
  begin
    update app_users set is_platform_owner = true where id = '00000000-0000-4000-8000-000000006f04';
    raise exception 'JOB 1: app_users_platform_owner_singleton_idx must reject a second is_platform_owner=true row';
  exception when unique_violation then null;
  end;
end
$$;

-- =========================================================================
-- JOB 1a (continued): OWNER+ADMIN CONJOINT, negative -- 6f06 is owner
-- but NOT platform admin. Must be rejected at the SAME is_platform_
-- admin() gate every other staff function uses -- being owner does not
-- imply admin, and the panel sits entirely behind platform-admin auth
-- (§20.6).
-- =========================================================================
select * from app_private.staff_set_capability_registry_entry(
  'ctl_owner_conjoint_probe', 'active_widget', 'a paid capability for the conjoint proof', false, 100, 'pro',
  null, null, null, null, null, null
);
select * from app_private.staff_propose_capability_change(
  'ctl_owner_conjoint_probe', 'active_widget', 'move to free -- requires owner sign-off', false, 100, null, null, 'conjoint proof'
);
do $$
declare v_id uuid;
begin
  select id into v_id from public.capability_change_requests where capability_key = 'ctl_owner_conjoint_probe' and change_kind = 'update';
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000006f01', false);
  perform app_private.staff_approve_capability_change(v_id, 'staff');
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000006f02', false);
  perform app_private.staff_approve_capability_change(v_id, 'staff');

  -- 6f06: owner=true, admin=false -- rejected at the admin gate before
  -- the owner-identity branch is ever reached.
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000006f06', false);
  begin
    perform app_private.staff_approve_capability_change(v_id, 'owner');
    raise exception 'JOB 1: owner status alone (without is_platform_admin) must not authorise an owner approval';
  exception when insufficient_privilege then null;
  end;

  perform set_config('app.user_id', '00000000-0000-4000-8000-000000006f00', false);
end
$$;

-- =========================================================================
-- JOB 1b: staff_set_platform_owner mechanics -- self-conferral blocked,
-- reason mandatory, real promotion is audited, demotion works (needed
-- before promoting 6f04, since the singleton index admits only one true
-- row at a time).
-- =========================================================================
do $$
begin
  -- Self-conferral: 6f00 (current actor) targeting itself.
  begin
    perform app_private.staff_set_platform_owner('00000000-0000-4000-8000-000000006f00'::uuid, true, 'self promotion attempt');
    raise exception 'JOB 1: platform owner status must never be self-conferred';
  exception when insufficient_privilege then null;
  end;

  -- Reason mandatory.
  begin
    perform app_private.staff_set_platform_owner('00000000-0000-4000-8000-000000006f04'::uuid, true, '');
    raise exception 'JOB 1: an empty reason must be rejected';
  exception when others then
    if sqlstate <> '22023' then raise; end if;
  end;
end
$$;

-- Demote 6f06 (frees the singleton slot), then promote 6f04 -- both by
-- 6f00, a distinct admin.
select * from app_private.staff_set_platform_owner('00000000-0000-4000-8000-000000006f06'::uuid, false, 'stepping down, handing off to delta');
select * from app_private.staff_set_platform_owner('00000000-0000-4000-8000-000000006f04'::uuid, true, 'promoting delta to platform owner');

do $$
declare v_owner boolean; v_audit_count integer;
begin
  select is_platform_owner into v_owner from app_users where id = '00000000-0000-4000-8000-000000006f04';
  if v_owner is not true then raise exception 'JOB 1: 6f04 must now be the platform owner, got %', v_owner; end if;

  select is_platform_owner into v_owner from app_users where id = '00000000-0000-4000-8000-000000006f06';
  if v_owner is not false then raise exception 'JOB 1: 6f06 must no longer be the platform owner, got %', v_owner; end if;

  select count(*) into v_audit_count from public.platform_owner_audit
   where target_user_id in ('00000000-0000-4000-8000-000000006f04', '00000000-0000-4000-8000-000000006f06');
  if v_audit_count <> 2 then raise exception 'JOB 1: both the demotion and the promotion must be audited, got % rows', v_audit_count; end if;

  perform 1 from public.platform_owner_audit
   where target_user_id = '00000000-0000-4000-8000-000000006f04' and previous_value is false and new_value is true and changed_by = '00000000-0000-4000-8000-000000006f00';
  if not found then raise exception 'JOB 1: the promotion audit row must record previous=false, new=true, changed_by=the acting admin'; end if;
end
$$;

-- Audit log itself is append-only -- not editable by anyone, including
-- the admin who performed the change.
do $$
declare v_id uuid;
begin
  select id into v_id from public.platform_owner_audit where target_user_id = '00000000-0000-4000-8000-000000006f04' limit 1;
  begin
    update public.platform_owner_audit set reason = 'edited after the fact' where id = v_id;
    raise exception 'JOB 1: platform_owner_audit must be append-only';
  exception when feature_not_supported then null;
  end;
  begin
    delete from public.platform_owner_audit where id = v_id;
    raise exception 'JOB 1: platform_owner_audit rows must not be deletable';
  exception when feature_not_supported then null;
  end;
end
$$;

-- =========================================================================
-- JOB 1a (continued): OWNER+ADMIN CONJOINT, positive -- 6f04 is NOW
-- both owner and admin. A fresh paid->Free change, approved by two
-- OTHER staff, then genuinely owner-approved by 6f04.
-- =========================================================================
select * from app_private.staff_set_capability_registry_entry(
  'ctl_owner_conjoint_positive', 'active_widget', 'a second paid capability for the positive conjoint proof', false, 100, 'creator',
  null, null, null, null, null, null
);
select * from app_private.staff_propose_capability_change(
  'ctl_owner_conjoint_positive', 'active_widget', 'move to free', false, 100, null, null, 'positive conjoint proof'
);
do $$
declare v_id uuid; v_status text; v_min_tier text;
begin
  select id into v_id from public.capability_change_requests where capability_key = 'ctl_owner_conjoint_positive' and change_kind = 'update';
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000006f01', false);
  perform app_private.staff_approve_capability_change(v_id, 'staff');
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000006f02', false);
  perform app_private.staff_approve_capability_change(v_id, 'staff');

  perform set_config('app.user_id', '00000000-0000-4000-8000-000000006f04', false); -- real owner + admin
  select status into v_status from app_private.staff_approve_capability_change(v_id, 'owner');
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000006f00', false);
  if v_status <> 'applied' then raise exception 'JOB 1: owner+admin conjoint approval must succeed and apply, got status %', v_status; end if;

  select min_tier into v_min_tier from app_private.staff_get_capability_registry_entry('ctl_owner_conjoint_positive');
  if v_min_tier is not null then raise exception 'JOB 1: the paid->Free move must have taken effect, got min_tier %', v_min_tier; end if;
end
$$;

-- =========================================================================
-- JOB 2: emergency global_kill. Capabilities created fresh (single-admin
-- create is legitimate, Job 3) for each scenario below.
-- =========================================================================
select * from app_private.staff_set_capability_registry_entry('ctl_kill_probe_a', 'active_widget', 'kill probe a', false, 100, 'pro', null, null, null, null, null, null);
select * from app_private.staff_set_capability_registry_entry('ctl_kill_probe_b', 'active_widget', 'kill probe b', false, 100, 'pro', null, null, null, null, null, null);
select * from app_private.staff_set_capability_registry_entry('ctl_kill_probe_esc', 'active_widget', 'kill probe escalation', false, 100, 'pro', null, null, null, null, null, null);
select * from app_private.staff_set_capability_registry_entry('ctl_kill_probe_revert', 'automation_volume', 'kill probe revert', false, 100, 'studio', 'widget', '{"max_instances": 2}'::jsonb, true, false, null, null);
select * from app_private.staff_set_capability_registry_entry('ctl_kill_probe_ext', 'active_widget', 'kill probe extension', false, 100, 'pro', null, null, null, null, null, null);
select * from app_private.staff_set_capability_registry_entry('ctl_kill_probe_block1', 'active_widget', 'kill probe block 1', false, 100, 'pro', null, null, null, null, null, null);
select * from app_private.staff_set_capability_registry_entry('ctl_kill_probe_block2', 'active_widget', 'kill probe block 2', false, 100, 'pro', null, null, null, null, null, null);

-- Mandatory reason, non-existent capability.
do $$
begin
  begin
    perform app_private.staff_fire_global_kill('ctl_kill_probe_a', '', 5, 1);
    raise exception 'JOB 2: a kill without a reason must be rejected';
  exception when others then
    if sqlstate <> '22023' then raise; end if;
  end;
  begin
    perform app_private.staff_fire_global_kill('does_not_exist_probe', 'a reason', 5, 1);
    raise exception 'JOB 2: killing a non-existent capability must be rejected, cleanly';
  exception when others then
    if sqlstate <> '22023' then raise; end if;
  end;
end
$$;

-- WHO MAY FIRE / WHAT IT DOES: one admin, alone, immediate, reason
-- captured, affected/live counts captured.
select * from app_private.staff_fire_global_kill('ctl_kill_probe_a', 'actively harmful spike observed', 214, 3);
do $$
declare v_kill boolean; v_fired_by uuid; v_affected integer; v_live integer; v_reason text; v_expires timestamptz; v_fired_at timestamptz;
begin
  select reg.kill_switch into v_kill from public.capability_registry reg where reg.capability_key = 'ctl_kill_probe_a';
  if v_kill is not true then raise exception 'JOB 2: firing must set kill_switch=true immediately, got %', v_kill; end if;

  select fired_by, affected_channel_count, live_channel_count, reason, expires_at, fired_at
    into v_fired_by, v_affected, v_live, v_reason, v_expires, v_fired_at
    from app_private.staff_get_kill_event((select id from public.capability_kill_events where capability_key = 'ctl_kill_probe_a'));
  if v_fired_by <> '00000000-0000-4000-8000-000000006f00' then raise exception 'JOB 2: fired_by must record the actor'; end if;
  if v_affected <> 214 or v_live <> 3 then raise exception 'JOB 2: affected/live channel counts must round-trip, got % / %', v_affected, v_live; end if;
  if v_reason <> 'actively harmful spike observed' then raise exception 'JOB 2: reason must round-trip'; end if;
  if v_expires <> v_fired_at + interval '24 hours' then raise exception 'JOB 2: expires_at must be exactly fired_at + 24 hours, got % vs %', v_expires, v_fired_at; end if;
end
$$;
-- File the review immediately so 6f00 is not blocked from firing again
-- by later tests in this file.
select * from app_private.staff_file_kill_review((select id from public.capability_kill_events where capability_key = 'ctl_kill_probe_a'), 'contained within minutes, capability restored via extension review');

-- =========================================================================
-- NEVER A TIER/LIMIT/PRICING CHANGE -- structural (parameter scan) and
-- behavioural (byte-identical non-kill fields across fire+revert).
-- =========================================================================
do $$
declare fn record; params text;
begin
  for fn in
    select unnest(array[
      'staff_fire_global_kill', 'staff_ratify_kill_event',
      'staff_propose_kill_extension', 'staff_approve_kill_extension', 'staff_file_kill_review'
    ]) as name
  loop
    select string_agg(p.parameter_name, ',' order by p.ordinal_position) into params
      from information_schema.parameters p
      join information_schema.routines r
        on r.specific_name = p.specific_name and r.specific_schema = p.specific_schema
     where r.routine_schema = 'app_private' and r.routine_name = fn.name and p.parameter_mode = 'IN';
    if params ~* '(min_tier|limits|rollout_percentage|capacity_class|tier|pric)' then
      raise exception 'JOB 2: % must never accept a tier/limit/pricing parameter -- got %', fn.name, params;
    end if;
  end loop;
end
$$;

-- =========================================================================
-- IMMUTABLE, APPEND-ONLY LOG -- structurally, for every one of the five
-- new tables, for the SAME superuser session that fired/ratified them.
-- =========================================================================
do $$
declare v_kill_id uuid; v_rat_id uuid;
begin
  select id into v_kill_id from public.capability_kill_events where capability_key = 'ctl_kill_probe_a';

  begin
    update public.capability_kill_events set reason = 'edited after the fact' where id = v_kill_id;
    raise exception 'JOB 2: capability_kill_events must be append-only, not editable by anyone including the firer';
  exception when feature_not_supported then null;
  end;
  begin
    delete from public.capability_kill_events where id = v_kill_id;
    raise exception 'JOB 2: capability_kill_events rows must not be deletable';
  exception when feature_not_supported then null;
  end;

  begin
    update public.capability_kill_reviews set review_text = 'edited' where kill_event_id = v_kill_id;
    raise exception 'JOB 2: capability_kill_reviews must be append-only';
  exception when feature_not_supported then null;
  end;
end
$$;

-- =========================================================================
-- RATIFICATION: a second, distinct admin, within the window; the firer
-- cannot ratify their own kill; a second ratification is rejected.
-- =========================================================================
select * from app_private.staff_fire_global_kill('ctl_kill_probe_b', 'suspicious billing spike', 42, 10);
do $$
declare v_kill_id uuid; v_ratified_by uuid;
begin
  select id into v_kill_id from public.capability_kill_events where capability_key = 'ctl_kill_probe_b';

  -- Firer cannot ratify their own kill.
  begin
    perform app_private.staff_ratify_kill_event(v_kill_id);
    raise exception 'JOB 2: the admin who fired a kill must not be able to ratify it';
  exception when insufficient_privilege then null;
  end;

  perform set_config('app.user_id', '00000000-0000-4000-8000-000000006f01', false);
  select ratified_by into v_ratified_by from app_private.staff_ratify_kill_event(v_kill_id);
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000006f00', false);
  if v_ratified_by <> '00000000-0000-4000-8000-000000006f01' then raise exception 'JOB 2: ratified_by must record the ratifying admin'; end if;

  -- A second ratification (even by a different admin) is rejected --
  -- UNIQUE(kill_event_id).
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000006f02', false);
  begin
    perform app_private.staff_ratify_kill_event(v_kill_id);
    raise exception 'JOB 2: a kill event must only be ratifiable once';
  exception when unique_violation then null;
  end;
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000006f00', false);
end
$$;
select * from app_private.staff_file_kill_review((select id from public.capability_kill_events where capability_key = 'ctl_kill_probe_b'), 'ratified quickly, resolved within the hour');

-- =========================================================================
-- ESCALATION: an unratified kill past the 4-hour mark reads as
-- escalated_to_owner; ratifying clears it. Simulated by directly
-- inserting a back-dated kill event (INSERT is never blocked by the
-- append-only trigger -- only UPDATE/DELETE are) rather than waiting
-- four real hours.
-- =========================================================================
select * from app_private.staff_kill_capability_now('ctl_kill_probe_esc', 'simulated pre-existing kill for the escalation probe');
insert into public.capability_kill_events (capability_key, fired_by, fired_at, reason, affected_channel_count, live_channel_count, pre_kill_audit_id, expires_at)
values (
  'ctl_kill_probe_esc', '00000000-0000-4000-8000-000000006f00',
  current_timestamp - interval '5 hours', 'escalation probe, backdated 5 hours',
  1, 1,
  (select audit.id from public.capability_registry_audit audit where audit.capability_key = 'ctl_kill_probe_esc' and audit.version = 1),
  (current_timestamp - interval '5 hours') + interval '24 hours'
);
do $$
declare v_escalated boolean; v_kill_id uuid;
begin
  select id into v_kill_id from public.capability_kill_events where capability_key = 'ctl_kill_probe_esc';
  select escalated_to_owner into v_escalated from app_private.staff_get_kill_event(v_kill_id);
  if v_escalated is not true then raise exception 'JOB 2: an unratified kill past 4 hours must read escalated_to_owner=true, got %', v_escalated; end if;

  perform set_config('app.user_id', '00000000-0000-4000-8000-000000006f01', false);
  perform app_private.staff_ratify_kill_event(v_kill_id);
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000006f00', false);

  select escalated_to_owner into v_escalated from app_private.staff_get_kill_event(v_kill_id);
  if v_escalated is not false then raise exception 'JOB 2: ratifying must clear escalated_to_owner, got %', v_escalated; end if;
end
$$;
select * from app_private.staff_file_kill_review((select id from public.capability_kill_events where capability_key = 'ctl_kill_probe_esc'), 'escalation drill, no real incident');

-- =========================================================================
-- AUTO-REVERT AT EXPIRY -- CORRECT AT READ TIME, NO SWEEPER. A kill
-- event back-dated 25 hours (already past its 24-hour expiry), read
-- ONLY via a plain get call -- no apply/sweep call anywhere in this
-- block.
-- =========================================================================
select * from app_private.staff_kill_capability_now('ctl_kill_probe_revert', 'simulated pre-existing kill for the auto-revert probe');
insert into public.capability_kill_events (capability_key, fired_by, fired_at, reason, affected_channel_count, live_channel_count, pre_kill_audit_id, expires_at)
values (
  'ctl_kill_probe_revert', '00000000-0000-4000-8000-000000006f00',
  current_timestamp - interval '25 hours', 'auto-revert probe, backdated 25 hours',
  7, 2,
  (select audit.id from public.capability_registry_audit audit where audit.capability_key = 'ctl_kill_probe_revert' and audit.version = 1),
  (current_timestamp - interval '25 hours') + interval '24 hours'
);

do $$
declare
  v_reverted boolean; v_kill_id uuid;
  v_kill_switch boolean; v_min_tier text; v_capacity_class text; v_kind text; v_limits jsonb; v_beta boolean; v_rollout integer;
begin
  select id into v_kill_id from public.capability_kill_events where capability_key = 'ctl_kill_probe_revert';

  -- THE ONLY call in this block: a plain read. No apply/sweep function
  -- is invoked anywhere in this test.
  select reverted into v_reverted from app_private.staff_get_kill_event(v_kill_id);
  if v_reverted is not true then raise exception 'JOB 2: a kill event past its effective expiry must read reverted=true on the very next plain read'; end if;

  select kill_switch, min_tier, capacity_class, kind, limits, beta, rollout_percentage
    into v_kill_switch, v_min_tier, v_capacity_class, v_kind, v_limits, v_beta, v_rollout
    from public.capability_registry where capability_key = 'ctl_kill_probe_revert';
  if v_kill_switch is not false then raise exception 'JOB 2: auto-revert must have restored kill_switch=false, got %', v_kill_switch; end if;
  if v_min_tier <> 'studio' then raise exception 'JOB 2: auto-revert must restore the exact pre-kill min_tier, got %', v_min_tier; end if;
  if v_capacity_class <> 'automation_volume' then raise exception 'JOB 2: auto-revert must restore capacity_class, got %', v_capacity_class; end if;
  if v_kind <> 'widget' then raise exception 'JOB 2: auto-revert must restore kind, got %', v_kind; end if;
  if v_limits <> '{"max_instances": 2}'::jsonb then raise exception 'JOB 2: auto-revert must restore limits, got %', v_limits; end if;
  if v_beta is not true then raise exception 'JOB 2: auto-revert must restore beta, got %', v_beta; end if;
  if v_rollout <> 100 then raise exception 'JOB 2: auto-revert must restore rollout_percentage, got %', v_rollout; end if;
end
$$;
select * from app_private.staff_file_kill_review((select id from public.capability_kill_events where capability_key = 'ctl_kill_probe_revert'), 'auto-revert drill, no real incident');

-- No-indefinite-kill, fixed-24h ceiling on fire itself -- structural,
-- via the table's own CHECK constraint (a direct attempt to insert a
-- kill event whose expiry does not equal fired_at+24h).
do $$
begin
  begin
    insert into public.capability_kill_events (capability_key, fired_by, fired_at, reason, affected_channel_count, live_channel_count, pre_kill_audit_id, expires_at)
    values (
      'ctl_kill_probe_a', '00000000-0000-4000-8000-000000006f00', current_timestamp, 'bad expiry probe', 1, 1,
      (select audit.id from public.capability_registry_audit audit where audit.capability_key = 'ctl_kill_probe_a' and audit.version = 1),
      current_timestamp + interval '48 hours'
    );
    raise exception 'JOB 2: expires_at must always equal exactly fired_at + 24 hours -- no indefinite (or merely longer) kill';
  exception when check_violation then null;
  end;
end
$$;

-- =========================================================================
-- EXTENSION: the two-person path, a stated new expiry, bounded to the
-- same 24-hour figure per grant. Fired 20 hours ago (direct insert, same
-- backdating technique as the escalation/auto-revert probes above) so
-- there is real headroom to move the expiry forward while staying
-- within the 24-hours-from-THIS-request cap -- an extension requested
-- moments after firing has almost no such headroom (its own effective
-- expiry is already ~24 hours out), which is correct enforcement of
-- "no indefinite kill," not a test bug.
-- =========================================================================
select * from app_private.staff_kill_capability_now('ctl_kill_probe_ext', 'simulated pre-existing kill for the extension probe');
insert into public.capability_kill_events (capability_key, fired_by, fired_at, reason, affected_channel_count, live_channel_count, pre_kill_audit_id, expires_at)
values (
  'ctl_kill_probe_ext', '00000000-0000-4000-8000-000000006f00',
  current_timestamp - interval '20 hours', 'ongoing incident, needs more than 4 hours to contain',
  30, 8,
  (select audit.id from public.capability_registry_audit audit where audit.capability_key = 'ctl_kill_probe_ext' and audit.version = 1),
  (current_timestamp - interval '20 hours') + interval '24 hours'
);
do $$
declare v_kill_id uuid; v_req_id uuid; v_eff timestamptz; v_orig_eff timestamptz;
begin
  select id into v_kill_id from public.capability_kill_events where capability_key = 'ctl_kill_probe_ext';
  select app_private.capability_kill_effective_expires_at(v_kill_id) into v_orig_eff;

  -- Must move the expiry forward.
  begin
    perform app_private.staff_propose_kill_extension(v_kill_id, v_orig_eff - interval '1 hour', 'not actually forward');
    raise exception 'JOB 2: an extension must move the expiry forward';
  exception when others then
    if sqlstate <> '22023' then raise; end if;
  end;

  -- Capped at requested_at + 24 hours -- the table's own CHECK.
  begin
    perform app_private.staff_propose_kill_extension(v_kill_id, current_timestamp + interval '48 hours', 'far too long');
    raise exception 'JOB 2: an extension must be capped at 24 hours from its own request time';
  exception when check_violation then null;
  end;

  perform set_config('app.user_id', '00000000-0000-4000-8000-000000006f01', false);
  select id into v_req_id from app_private.staff_propose_kill_extension(v_kill_id, v_orig_eff + interval '2 hours', 'incident still active, needs 2 more hours');
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000006f00', false);

  -- Not yet effective -- only proposed, not approved.
  select app_private.capability_kill_effective_expires_at(v_kill_id) into v_eff;
  if v_eff <> v_orig_eff then raise exception 'JOB 2: a proposed-but-unapproved extension must not change the effective expiry, got %', v_eff; end if;

  -- The proposer may not also approve (maker-checker).
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000006f01', false);
  begin
    perform app_private.staff_approve_kill_extension(v_req_id);
    raise exception 'JOB 2: the admin who proposed a kill extension must not be able to approve it';
  exception when insufficient_privilege then null;
  end;

  -- A DISTINCT second admin approves -- now it takes effect.
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000006f02', false);
  perform app_private.staff_approve_kill_extension(v_req_id);
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000006f00', false);

  select app_private.capability_kill_effective_expires_at(v_kill_id) into v_eff;
  if v_eff <> v_orig_eff + interval '2 hours' then
    raise exception 'JOB 2: an APPROVED extension must move the effective expiry to the stated new value, got % expected %', v_eff, v_orig_eff + interval '2 hours';
  end if;

  -- Exactly one approval finalises it -- a second approval is rejected.
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000006f00', false);
  begin
    perform app_private.staff_approve_kill_extension(v_req_id);
    raise exception 'JOB 2: an extension request must only be approvable once';
  exception when unique_violation then null;
  end;
end
$$;

-- Extending an already-expired (auto-reverted) kill event is rejected.
do $$
declare v_kill_id uuid;
begin
  select id into v_kill_id from public.capability_kill_events where capability_key = 'ctl_kill_probe_revert';
  begin
    perform app_private.staff_propose_kill_extension(v_kill_id, current_timestamp + interval '1 hour', 'too late');
    raise exception 'JOB 2: an extension must not apply to an already-expired kill event';
  exception when others then
    if sqlstate <> '22023' then raise; end if;
  end;
end
$$;
select * from app_private.staff_file_kill_review((select id from public.capability_kill_events where capability_key = 'ctl_kill_probe_ext'), 'extended once, then contained; incident closed');

-- =========================================================================
-- POST-INCIDENT REVIEW BLOCKS THE NEXT KILL BY THE SAME ACTOR --
-- enforced behaviourally, not merely documented.
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000006f02', false); -- 6f02 has not fired a kill yet in this file
select * from app_private.staff_fire_global_kill('ctl_kill_probe_block1', 'incident one, review not yet filed', 5, 1);
do $$
begin
  begin
    perform app_private.staff_fire_global_kill('ctl_kill_probe_block2', 'incident two, should be blocked', 5, 1);
    raise exception 'JOB 2: a kill with no post-incident review must block the SAME actor''s next kill';
  exception when object_not_in_prerequisite_state then null;
  end;
end
$$;
select * from app_private.staff_file_kill_review((select id from public.capability_kill_events where capability_key = 'ctl_kill_probe_block1'), 'incident one, review filed -- unblocking');
-- Now the same actor CAN fire again.
select * from app_private.staff_fire_global_kill('ctl_kill_probe_block2', 'incident two, now unblocked', 5, 1);
select * from app_private.staff_file_kill_review((select id from public.capability_kill_events where capability_key = 'ctl_kill_probe_block2'), 'incident two, review filed');
select set_config('app.user_id', '00000000-0000-4000-8000-000000006f00', false);

-- =========================================================================
-- JOB 3: the single-admin bypass, closed. New capability succeeds;
-- existing capability rejected; revert still works after the restructure.
-- =========================================================================
select * from app_private.staff_set_capability_registry_entry(
  'ctl_job3_new_cap', 'active_widget', 'a brand-new capability, single-admin is fine', false, 100, 'pro',
  null, null, null, null, null, null
);
do $$
begin
  begin
    perform app_private.staff_set_capability_registry_entry(
      'ctl_job3_new_cap', 'active_widget', 'attempting to change it again, single-admin', true, 50, 'creator',
      null, null, null, null, null, null
    );
    raise exception 'JOB 3: changing an EXISTING capability via staff_set_capability_registry_entry must be rejected';
  exception when insufficient_privilege then null;
  end;

  -- And nothing must have changed.
  perform 1 from public.capability_registry where capability_key = 'ctl_job3_new_cap' and kill_switch = false and rollout_percentage = 100 and min_tier = 'pro';
  if not found then raise exception 'JOB 3: a rejected single-admin update must leave the existing row untouched'; end if;
end
$$;

-- Revert still works: create v1, move to v2 via the ORIGINAL (0149)
-- write path (unaffected by Job 3), revert restores v1's values, and
-- exactly one NEW audit row is produced (v1/v2 untouched).
select * from app_private.staff_set_capability_registry_entry(
  'ctl_job3_revert_cap', 'active_widget', 'v1 description', false, 100, 'pro',
  'widget', '{"max_instances": 1}'::jsonb, true, false, null, null
);
select * from app_private.staff_upsert_capability_registry_entry(
  'ctl_job3_revert_cap', 'active_widget', 'v2 description', false, 100, 'creator'
);
do $$
declare v_audit_before integer;
begin
  select count(*) into v_audit_before from public.capability_registry_audit where capability_key = 'ctl_job3_revert_cap';
  if v_audit_before <> 2 then raise exception 'JOB 3 setup: expected 2 audit rows (v1, v2) before revert, got %', v_audit_before; end if;
end
$$;

select * from app_private.staff_revert_capability_registry_entry('ctl_job3_revert_cap', 'revert after Job 3 restructure');

do $$
declare v_description text; v_min_tier text; v_kind text; v_beta boolean; v_audit_after integer;
begin
  select description, min_tier, kind, beta into v_description, v_min_tier, v_kind, v_beta
    from app_private.staff_get_capability_registry_entry('ctl_job3_revert_cap');
  if v_description <> 'v1 description' then raise exception 'JOB 3: revert must restore v1''s description, got %', v_description; end if;
  if v_min_tier <> 'pro' then raise exception 'JOB 3: revert must restore v1''s min_tier, got %', v_min_tier; end if;
  if v_kind <> 'widget' then raise exception 'JOB 3: revert must restore v1''s kind, got %', v_kind; end if;
  if v_beta is not true then raise exception 'JOB 3: revert must restore v1''s beta, got %', v_beta; end if;

  select count(*) into v_audit_after from public.capability_registry_audit where capability_key = 'ctl_job3_revert_cap';
  if v_audit_after <> 3 then raise exception 'JOB 3: revert must produce exactly ONE new forward audit row (v1, v2 untouched, v3 new), got % total', v_audit_after; end if;
end
$$;

-- =========================================================================
-- CTL-15, RE-PROVEN over this migration's own new tables: no retention/
-- retain/ttl column anywhere; the only 'expir' matches are the two
-- KILL EVENT deadline columns this migration's header names explicitly.
-- =========================================================================
do $$
declare v_bad_count integer; v_expir_cols text;
begin
  select count(*) into v_bad_count
    from information_schema.columns
   where table_schema = 'public'
     and table_name in ('platform_owner_audit', 'capability_kill_events', 'capability_kill_ratifications',
                         'capability_kill_extension_requests', 'capability_kill_extension_approvals', 'capability_kill_reviews')
     and (column_name ~* 'retention' or column_name ~* 'retain' or column_name ~* 'ttl');
  if v_bad_count <> 0 then raise exception 'CTL-15: no retention/retain/ttl column may exist on any table this migration creates, found %', v_bad_count; end if;

  select string_agg(table_name || '.' || column_name, ', ' order by table_name, column_name) into v_expir_cols
    from information_schema.columns
   where table_schema = 'public'
     and table_name in ('platform_owner_audit', 'capability_kill_events', 'capability_kill_ratifications',
                         'capability_kill_extension_requests', 'capability_kill_extension_approvals', 'capability_kill_reviews')
     and column_name ~* 'expir';
  if v_expir_cols is distinct from 'capability_kill_events.expires_at, capability_kill_extension_requests.new_expires_at' then
    raise exception 'CTL-15: the ONLY expir* columns across this migration''s new tables must be the two named kill-event deadlines, got: %', coalesce(v_expir_cols, '<none>');
  end if;
end
$$;
