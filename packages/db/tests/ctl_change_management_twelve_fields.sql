-- CTL -- migration 0157: widening the change-management workflow
-- (migration 0152) to carry all twelve §20.2 registry fields.
--
-- Covers, per this task's own vertical-slice instructions:
--   * a full propose -> two-staff-approve -> apply cycle carrying all
--     twelve fields (not just the original six);
--   * a paid->Free move through the WIDENED propose call still demands
--     real owner identity (CTL-07 rule 2 unchanged by the widening);
--   * revert still restores all twelve fields (CTL-08, unchanged body,
--     re-proven over the widened 24-column output shape);
--   * merge semantics: an ordinary six-field-only propose call (the
--     original 8-positional-argument shape) preserves the six new
--     fields untouched on apply -- the permanent feature this migration
--     gives what was, before it, an accident of 0149's narrower write
--     function;
--   * CTL-06 read-time correctness re-proven over a change that DOES
--     carry twelve-field content;
--   * CTL-09 re-proven (both the registry's own whitelist and the
--     change-request table's copy) unaffected by the widening;
--   * CTL-14/CTL-15/CTL-03 re-asserted: no retention/TTL/expiry column
--     anywhere in this migration's surface, no new bsa_app table grant.
--
-- Fixture: own app_users block '...7100'-'...7105' (pre-assigned to
-- this migration, fixture range 7100-71ff, verified free by inspection
-- of every other *.sql file in this directory at authoring time). No
-- channel/channel_membership fixture is needed -- every function this
-- file exercises is gated by app_private.is_platform_admin() alone,
-- same posture 0152/0153/0155's own test files already took.
-- 00_base_world.sql is not touched by this file or by migration 0157.
\set ON_ERROR_STOP on

insert into app_users (id, external_subject, display_name, created_at, updated_at, is_platform_admin, is_platform_owner)
values
  ('00000000-0000-4000-8000-000000007100', 'google-ctl12-staff-alpha', 'CTL12 Staff Alpha', current_timestamp, current_timestamp, true, false),
  ('00000000-0000-4000-8000-000000007101', 'google-ctl12-staff-beta', 'CTL12 Staff Beta', current_timestamp, current_timestamp, true, false),
  ('00000000-0000-4000-8000-000000007102', 'google-ctl12-staff-gamma', 'CTL12 Staff Gamma', current_timestamp, current_timestamp, true, false),
  -- The real platform owner (singleton, app_users_platform_owner_singleton_idx)
  -- in THIS file's own isolated database -- run-sql-suite.sh clones a
  -- fresh database per test file, so this does not collide with any
  -- other file's own owner fixture.
  ('00000000-0000-4000-8000-000000007103', 'google-ctl12-owner', 'CTL12 Real Owner', current_timestamp, current_timestamp, true, true),
  -- A platform admin who is NOT the owner -- proves an 'owner' approval
  -- is rejected for identity, not merely permitted by admin status,
  -- even through the WIDENED propose/approve call shapes this migration
  -- ships.
  ('00000000-0000-4000-8000-000000007104', 'google-ctl12-staff-delta-nonowner', 'CTL12 Staff Delta (not owner)', current_timestamp, current_timestamp, true, false)
on conflict (id) do nothing;

select set_config('app.user_id', '00000000-0000-4000-8000-000000007100', false);

-- =========================================================================
-- STRUCTURAL: the widened 24-column output shape, independently
-- re-verified here (packages/db/tests/ctl_change_management.sql already
-- asserts the same thing for staff_get_capability_change/staff_list_
-- capability_changes -- this is this migration's OWN proof, same
-- posture ctl_registry_spec_alignment.sql already took for re-asserting
-- resolve_channel_capabilities' unchanged shape independently of 0149's
-- own assertion).
-- =========================================================================
do $$
declare
  expected text := 'id,capability_key,change_kind,status,proposed_capacity_class,proposed_description,proposed_kill_switch,proposed_rollout_percentage,proposed_min_tier,proposed_kind,proposed_limits,proposed_beta,proposed_marketing_visible,proposed_marketing_label,proposed_marketing_blurb,effective_at,requires_owner_signoff,staff_approval_count,owner_approval_count,created_by,created_at,applied_at,decided_at,reason';
  fn_name text;
  cols text;
begin
  foreach fn_name in array array['staff_get_capability_change', 'staff_list_capability_changes', 'staff_propose_capability_change', 'staff_approve_capability_change', 'staff_reject_capability_change', 'staff_kill_capability_now', 'staff_revert_capability_registry_entry', 'capability_change_row']
  loop
    select string_agg(p.parameter_name, ',' order by p.ordinal_position) into cols
      from information_schema.parameters p
      join information_schema.routines r
        on r.specific_name = p.specific_name and r.specific_schema = p.specific_schema
     where r.routine_schema = 'app_private' and r.routine_name = fn_name and p.parameter_mode = 'OUT';
    if cols is distinct from expected then
      raise exception '% must project exactly the widened 24-column shape %. Found: %', fn_name, expected, coalesce(cols, '<none>');
    end if;
  end loop;
end
$$;

-- =========================================================================
-- SCENARIO A: full propose -> two-staff-approve -> apply cycle, all
-- twelve fields carried and applied.
-- =========================================================================
select * from app_private.staff_set_capability_registry_entry(
  'ctl12_full_widget', 'active_widget', 'initial state before the twelve-field workflow', false, 100, 'pro',
  'widget', '{"max_instances": 1}'::jsonb, false, false, null, null
);

select * from app_private.staff_propose_capability_change(
  'ctl12_full_widget', 'team_seat', 'updated via the widened twelve-field workflow', false, 80, 'creator',
  null, 'ctl12 scenario A: full twelve-field cycle',
  'module', '{"max_instances": 5, "max_duration_ms": 9000}'::jsonb, true, true, 'New Module', 'A module you can use.'
);

do $$
declare v_id uuid; v_status text;
begin
  select id into v_id from public.capability_change_requests
   where capability_key = 'ctl12_full_widget' and reason = 'ctl12 scenario A: full twelve-field cycle';

  perform set_config('app.user_id', '00000000-0000-4000-8000-000000007101', false);
  select status into v_status from app_private.staff_approve_capability_change(v_id, 'staff');
  if v_status <> 'pending_approval' then raise exception 'SCENARIO A: one staff approval alone must not complete an ordinary change, got %', v_status; end if;

  perform set_config('app.user_id', '00000000-0000-4000-8000-000000007102', false);
  select status into v_status from app_private.staff_approve_capability_change(v_id, 'staff');
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000007100', false);
  -- effective_at defaulted to "now" (immediate change), so the SECOND
  -- staff approval's own return -- which flows through capability_
  -- change_row's lazy-apply check -- already shows 'applied', same
  -- honest read-time-not-approve-time distinction packages/db/tests/
  -- ctl_change_management.sql's own CTL-06 central proof documents.
  if v_status <> 'applied' then raise exception 'SCENARIO A: an unstaged twelve-field change must be applied by the second approval''s own read, got %', v_status; end if;
end
$$;

do $$
declare
  v_capacity text; v_description text; v_kill boolean; v_rollout integer; v_min_tier text;
  v_kind text; v_limits jsonb; v_beta boolean; v_marketing_visible boolean; v_label text; v_blurb text;
begin
  select capacity_class, description, kill_switch, rollout_percentage, min_tier,
         kind, limits, beta, marketing_visible, marketing_label, marketing_blurb
    into v_capacity, v_description, v_kill, v_rollout, v_min_tier,
         v_kind, v_limits, v_beta, v_marketing_visible, v_label, v_blurb
    from app_private.staff_get_capability_registry_entry('ctl12_full_widget');

  if v_capacity <> 'team_seat' then raise exception 'SCENARIO A: capacity_class must match the proposal, got %', v_capacity; end if;
  if v_description <> 'updated via the widened twelve-field workflow' then raise exception 'SCENARIO A: description must match the proposal, got %', v_description; end if;
  if v_kill is not false then raise exception 'SCENARIO A: kill_switch must match the proposal, got %', v_kill; end if;
  if v_rollout <> 80 then raise exception 'SCENARIO A: rollout_percentage must match the proposal, got %', v_rollout; end if;
  if v_min_tier <> 'creator' then raise exception 'SCENARIO A: min_tier must match the proposal, got %', v_min_tier; end if;
  if v_kind <> 'module' then raise exception 'SCENARIO A (the twelve-field proof itself): kind must match the proposal, got %', v_kind; end if;
  if v_limits <> '{"max_instances": 5, "max_duration_ms": 9000}'::jsonb then raise exception 'SCENARIO A: limits must match the proposal, got %', v_limits; end if;
  if v_beta is not true then raise exception 'SCENARIO A: beta must match the proposal, got %', v_beta; end if;
  if v_marketing_visible is not true then raise exception 'SCENARIO A: marketing_visible must match the proposal, got %', v_marketing_visible; end if;
  if v_label <> 'New Module' then raise exception 'SCENARIO A: marketing_label must match the proposal, got %', v_label; end if;
  if v_blurb <> 'A module you can use.' then raise exception 'SCENARIO A: marketing_blurb must match the proposal, got %', v_blurb; end if;
end
$$;

-- =========================================================================
-- SCENARIO B (merge semantics): an ORDINARY six-field-only propose call
-- (the original 8-positional-argument shape, the six new parameters
-- left at their SQL default of NULL) must PRESERVE the capability's
-- current kind/limits/beta/marketing_* untouched on apply -- the
-- permanent, documented feature migration 0157's header promises, not
-- an accident of 0149's narrower write function.
-- =========================================================================
select * from app_private.staff_propose_capability_change(
  'ctl12_full_widget', 'active_widget', 'an ordinary six-field-only change, old call shape', false, 60, 'creator',
  null, 'ctl12 scenario B: merge semantics preserve the six new fields'
);

do $$
declare v_id uuid; v_status text;
begin
  select id into v_id from public.capability_change_requests
   where capability_key = 'ctl12_full_widget' and reason = 'ctl12 scenario B: merge semantics preserve the six new fields';

  perform set_config('app.user_id', '00000000-0000-4000-8000-000000007101', false);
  perform app_private.staff_approve_capability_change(v_id, 'staff');
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000007102', false);
  select status into v_status from app_private.staff_approve_capability_change(v_id, 'staff');
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000007100', false);
  if v_status <> 'applied' then raise exception 'SCENARIO B: an unstaged six-field-only change must still apply, got %', v_status; end if;
end
$$;

do $$
declare
  v_capacity text; v_rollout integer;
  v_kind text; v_limits jsonb; v_beta boolean; v_marketing_visible boolean; v_label text; v_blurb text;
begin
  select capacity_class, rollout_percentage, kind, limits, beta, marketing_visible, marketing_label, marketing_blurb
    into v_capacity, v_rollout, v_kind, v_limits, v_beta, v_marketing_visible, v_label, v_blurb
    from app_private.staff_get_capability_registry_entry('ctl12_full_widget');

  if v_capacity <> 'active_widget' then raise exception 'SCENARIO B: the fields this change DID propose must still apply, got capacity_class %', v_capacity; end if;
  if v_rollout <> 60 then raise exception 'SCENARIO B: rollout_percentage must match this proposal, got %', v_rollout; end if;
  -- MERGE PROOF: kind/limits/beta/marketing_* must be BYTE-IDENTICAL to
  -- scenario A's own values -- an ordinary change that never mentioned
  -- them must not have touched them at all.
  if v_kind <> 'module' then raise exception 'MERGE SEMANTICS: an ordinary six-field-only change must PRESERVE kind, got %', v_kind; end if;
  if v_limits <> '{"max_instances": 5, "max_duration_ms": 9000}'::jsonb then raise exception 'MERGE SEMANTICS: an ordinary six-field-only change must PRESERVE limits, got %', v_limits; end if;
  if v_beta is not true then raise exception 'MERGE SEMANTICS: an ordinary six-field-only change must PRESERVE beta, got %', v_beta; end if;
  if v_marketing_visible is not true then raise exception 'MERGE SEMANTICS: an ordinary six-field-only change must PRESERVE marketing_visible, got %', v_marketing_visible; end if;
  if v_label <> 'New Module' then raise exception 'MERGE SEMANTICS: an ordinary six-field-only change must PRESERVE marketing_label, got %', v_label; end if;
  if v_blurb <> 'A module you can use.' then raise exception 'MERGE SEMANTICS: an ordinary six-field-only change must PRESERVE marketing_blurb, got %', v_blurb; end if;
end
$$;

-- =========================================================================
-- SCENARIO C: CTL-06 read-time correctness, re-proven over a change that
-- carries twelve-field content -- a staged, already-due change is
-- applied on the very next plain read, with NO explicit apply/sweep
-- call anywhere in this block, and re-reading afterward does not
-- double-apply (version stable).
-- =========================================================================
select * from app_private.staff_propose_capability_change(
  'ctl12_readtime_probe', 'ai_usage', 'due-in-the-past staging proof, twelve fields', false, 100, 'pro',
  current_timestamp - interval '1 minute', 'ctl12 scenario C: read-time correctness',
  'feature', '{"max_duration_ms": 4000}'::jsonb, true, false, null, null
);

do $$
declare v_id uuid;
begin
  select id into v_id from public.capability_change_requests where capability_key = 'ctl12_readtime_probe';
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000007101', false);
  perform app_private.staff_approve_capability_change(v_id, 'staff');
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000007102', false);
  perform app_private.staff_approve_capability_change(v_id, 'staff');
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000007100', false);
end
$$;

do $$
declare v_status text; v_kind text; v_version_before integer; v_version_after integer; v_id uuid;
begin
  select status into v_status from public.capability_change_requests where capability_key = 'ctl12_readtime_probe';
  if v_status <> 'applied' then raise exception 'SCENARIO C: a due twelve-field change must be applied by the read that first observes it past effective_at, got %', v_status; end if;

  select kind into v_kind from public.capability_registry where capability_key = 'ctl12_readtime_probe';
  if v_kind <> 'feature' then raise exception 'SCENARIO C: kind must have been applied along with the original six fields, got %', v_kind; end if;

  select version into v_version_before from public.capability_registry where capability_key = 'ctl12_readtime_probe';
  select id into v_id from public.capability_change_requests where capability_key = 'ctl12_readtime_probe';
  perform app_private.staff_get_capability_change(v_id);
  perform * from app_private.staff_list_capability_changes('applied', 100);
  select version into v_version_after from public.capability_registry where capability_key = 'ctl12_readtime_probe';
  if v_version_after <> v_version_before then raise exception 'SCENARIO C: an already-applied change must not be reapplied by a later read, version drifted % -> %', v_version_before, v_version_after; end if;
end
$$;

-- =========================================================================
-- SCENARIO D: a paid->Free move THROUGH THE WIDENED PROPOSE CALL (real
-- values supplied for the six new fields too) still demands real owner
-- identity -- CTL-07 rule 2 is unchanged by this migration's widening.
-- =========================================================================
select * from app_private.staff_set_capability_registry_entry(
  'ctl12_paid_to_free', 'active_widget', 'a paid capability for the owner-identity proof', false, 100, 'studio',
  'feature', '{}'::jsonb, true, false, null, null
);

select * from app_private.staff_propose_capability_change(
  'ctl12_paid_to_free', 'active_widget', 'move to free, twelve fields at once', false, 100, null,
  null, 'ctl12 scenario D: paid to free still demands owner identity',
  'hub_lane', '{"max_instances": 2}'::jsonb, false, true, 'Free Hub', 'Now free for everyone.'
);

do $$
declare v_id uuid; v_owner_needed boolean;
begin
  select id, requires_owner_signoff into v_id, v_owner_needed
    from public.capability_change_requests
   where capability_key = 'ctl12_paid_to_free' and reason = 'ctl12 scenario D: paid to free still demands owner identity';
  if v_owner_needed is not true then raise exception 'SCENARIO D: moving a paid capability to free must require owner sign-off even when the same change also carries the six new fields, got %', v_owner_needed; end if;
end
$$;

do $$
declare v_id uuid; v_status text;
begin
  select id into v_id from public.capability_change_requests
   where capability_key = 'ctl12_paid_to_free' and reason = 'ctl12 scenario D: paid to free still demands owner identity';

  perform set_config('app.user_id', '00000000-0000-4000-8000-000000007101', false);
  perform app_private.staff_approve_capability_change(v_id, 'staff');
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000007102', false);
  select status into v_status from app_private.staff_approve_capability_change(v_id, 'staff');
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000007100', false);
  if v_status <> 'pending_approval' then raise exception 'SCENARIO D: two staff approvals alone must not complete a paid->Free move, even one carrying twelve fields, got %', v_status; end if;

  -- A platform admin who is NOT the real owner must be rejected.
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000007104', false);
  begin
    perform app_private.staff_approve_capability_change(v_id, 'owner');
    raise exception 'SCENARIO D: an owner approval by a non-owner platform admin must be rejected';
  exception when insufficient_privilege then null;
  end;
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000007100', false);
end
$$;

do $$
declare
  v_id uuid; v_status text;
  v_min_tier text; v_kind text; v_marketing_visible boolean; v_label text;
begin
  select id into v_id from public.capability_change_requests
   where capability_key = 'ctl12_paid_to_free' and reason = 'ctl12 scenario D: paid to free still demands owner identity';

  -- The real owner (also a platform admin) completes it.
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000007103', false);
  select status into v_status from app_private.staff_approve_capability_change(v_id, 'owner');
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000007100', false);
  if v_status <> 'applied' then raise exception 'SCENARIO D: a genuine owner approval must complete and apply a paid->Free move, got %', v_status; end if;

  select min_tier, kind, marketing_visible, marketing_label
    into v_min_tier, v_kind, v_marketing_visible, v_label
    from app_private.staff_get_capability_registry_entry('ctl12_paid_to_free');
  if v_min_tier is not null then raise exception 'SCENARIO D: min_tier must now be free (null), got %', v_min_tier; end if;
  if v_kind <> 'hub_lane' then raise exception 'SCENARIO D: kind must have been applied alongside the owner-approved tier move, got %', v_kind; end if;
  if v_marketing_visible is not true then raise exception 'SCENARIO D: marketing_visible must have been applied alongside the owner-approved tier move, got %', v_marketing_visible; end if;
  if v_label <> 'Free Hub' then raise exception 'SCENARIO D: marketing_label must have been applied alongside the owner-approved tier move, got %', v_label; end if;
end
$$;

-- =========================================================================
-- SCENARIO E: CTL-08 revert still restores all twelve fields, not just
-- the original six -- proven over a change produced by the WIDENED
-- workflow this migration ships (the prior audit snapshot revert reads
-- from already carries the twelve-field row shape).
-- =========================================================================
select * from app_private.staff_set_capability_registry_entry(
  'ctl12_revert_probe', 'custom_asset', 'version 1, full twelve fields', false, 100, 'creator',
  'lobby_mode', '{"max_instances": 3}'::jsonb, false, true, 'Original Label', 'Original blurb.'
);

select * from app_private.staff_propose_capability_change(
  'ctl12_revert_probe', 'automation_volume', 'version 2, changed via the twelve-field workflow', true, 50, 'creator',
  null, 'ctl12 scenario E: revert restores twelve fields',
  'ai_feature', '{"max_instances": 9}'::jsonb, true, false, null, null
);

do $$
declare v_id uuid;
begin
  select id into v_id from public.capability_change_requests
   where capability_key = 'ctl12_revert_probe' and reason = 'ctl12 scenario E: revert restores twelve fields';
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000007101', false);
  perform app_private.staff_approve_capability_change(v_id, 'staff');
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000007102', false);
  perform app_private.staff_approve_capability_change(v_id, 'staff');
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000007100', false);
end
$$;

-- Confirm version 2 (the changed state) really did apply before
-- reverting away from it -- otherwise the revert assertion below would
-- be vacuously true.
do $$
declare v_kind text; v_beta boolean; v_marketing_visible boolean;
begin
  select kind, beta, marketing_visible into v_kind, v_beta, v_marketing_visible
    from app_private.staff_get_capability_registry_entry('ctl12_revert_probe');
  if v_kind <> 'ai_feature' then raise exception 'SCENARIO E setup: version 2''s kind must have applied first, got %', v_kind; end if;
  if v_beta is not true then raise exception 'SCENARIO E setup: version 2''s beta must have applied first, got %', v_beta; end if;
  if v_marketing_visible is not false then raise exception 'SCENARIO E setup: version 2''s marketing_visible must have applied first, got %', v_marketing_visible; end if;
end
$$;

select * from app_private.staff_revert_capability_registry_entry('ctl12_revert_probe', 'ctl12 scenario E revert');

do $$
declare
  v_capacity text; v_description text; v_kill boolean; v_rollout integer; v_min_tier text;
  v_kind text; v_limits jsonb; v_beta boolean; v_marketing_visible boolean; v_label text; v_blurb text;
  v_change_kind text; v_status text; v_proposed_kind text;
begin
  select capacity_class, description, kill_switch, rollout_percentage, min_tier,
         kind, limits, beta, marketing_visible, marketing_label, marketing_blurb
    into v_capacity, v_description, v_kill, v_rollout, v_min_tier,
         v_kind, v_limits, v_beta, v_marketing_visible, v_label, v_blurb
    from app_private.staff_get_capability_registry_entry('ctl12_revert_probe');

  if v_capacity <> 'custom_asset' then raise exception 'REVERT: capacity_class must be restored to version 1, got %', v_capacity; end if;
  if v_description <> 'version 1, full twelve fields' then raise exception 'REVERT: description must be restored to version 1, got %', v_description; end if;
  if v_kill is not false then raise exception 'REVERT: kill_switch must be restored to version 1, got %', v_kill; end if;
  if v_rollout <> 100 then raise exception 'REVERT: rollout_percentage must be restored to version 1, got %', v_rollout; end if;
  if v_min_tier <> 'creator' then raise exception 'REVERT: min_tier must be restored to version 1, got %', v_min_tier; end if;
  if v_kind <> 'lobby_mode' then raise exception 'REVERT (the twelve-field proof itself): kind must be restored to version 1, got %', v_kind; end if;
  if v_limits <> '{"max_instances": 3}'::jsonb then raise exception 'REVERT: limits must be restored to version 1, got %', v_limits; end if;
  if v_beta is not false then raise exception 'REVERT: beta must be restored to version 1, got %', v_beta; end if;
  if v_marketing_visible is not true then raise exception 'REVERT: marketing_visible must be restored to version 1, got %', v_marketing_visible; end if;
  if v_label <> 'Original Label' then raise exception 'REVERT: marketing_label must be restored to version 1, got %', v_label; end if;
  if v_blurb <> 'Original blurb.' then raise exception 'REVERT: marketing_blurb must be restored to version 1, got %', v_blurb; end if;

  select change_kind, status, proposed_kind into v_change_kind, v_status, v_proposed_kind
    from public.capability_change_requests
   where capability_key = 'ctl12_revert_probe' and change_kind = 'revert';
  if v_change_kind <> 'revert' then raise exception 'REVERT: the revert must record its own change_kind=revert row'; end if;
  if v_status <> 'applied' then raise exception 'REVERT: a revert row must always be immediately applied, got %', v_status; end if;
  if v_proposed_kind <> 'lobby_mode' then raise exception 'REVERT: the revert''s own audit row must show the RESTORED kind (proving the widened output shape genuinely carries it), got %', v_proposed_kind; end if;
end
$$;

-- =========================================================================
-- CTL-09, re-proven: proposed_capacity_class's closed whitelist is
-- UNCHANGED by this migration -- BEHAVIOURALLY (every §12.6.1 forbidden
-- class is still rejected, even on a call that also carries real values
-- for the six new fields) and STRUCTURALLY (both capability_registry.
-- capacity_class's and capability_change_requests.proposed_capacity_class's
-- own pg_get_constraintdef contain none of the nine forbidden tokens --
-- the same both-definitions scan 0152's own header requires, extended
-- to confirm this migration did not touch either).
-- =========================================================================
do $$
declare forbidden text; probe_key text;
begin
  foreach forbidden in array array[
    'payment', 'receipt', 'refund', 'audit_trail', 'supporter_relationship',
    'event_history', 'configuration', 'layout', 'moderation_history'
  ]
  loop
    probe_key := 'ctl12_ctl09_probe_' || forbidden;
    begin
      perform app_private.staff_propose_capability_change(
        probe_key, forbidden, 'CTL-09 probe: gate a durable creator record, twelve-field call', false, 100, null,
        null, 'ctl12 CTL-09 probe', 'widget', '{}'::jsonb, false, false, null, null
      );
      raise exception 'CTL-09: proposed_capacity_class % must still be rejected on the widened fourteen-argument call -- this panel must never be able to propose gating a durable creator record (§12.6)', forbidden;
    exception when check_violation then null;
    end;
  end loop;
end
$$;

do $$
declare def text; forbidden text;
begin
  select pg_get_constraintdef(oid) into def
    from pg_constraint
   where conrelid = 'public.capability_registry'::regclass
     and conname = 'capability_registry_capacity_class_check';
  foreach forbidden in array array[
    'payment', 'receipt', 'refund', 'audit_trail', 'supporter_relationship',
    'event_history', 'configuration', 'layout', 'moderation_history'
  ]
  loop
    if def ilike '%' || forbidden || '%' then
      raise exception 'CTL-09/CTL-14 structural: capability_registry.capacity_class''s own whitelist must not contain forbidden token %, definition: %', forbidden, def;
    end if;
  end loop;

  select pg_get_constraintdef(oid) into def
    from pg_constraint
   where conrelid = 'public.capability_change_requests'::regclass
     and conname = 'capability_change_requests_proposed_capacity_class_check';
  foreach forbidden in array array[
    'payment', 'receipt', 'refund', 'audit_trail', 'supporter_relationship',
    'event_history', 'configuration', 'layout', 'moderation_history'
  ]
  loop
    if def ilike '%' || forbidden || '%' then
      raise exception 'CTL-09 structural: capability_change_requests.proposed_capacity_class''s own whitelist must not contain forbidden token %, definition: %', forbidden, def;
    end if;
  end loop;
end
$$;

-- =========================================================================
-- CTL-14, re-asserted: capability_registry.capacity_class's whitelist is
-- unchanged (this migration adds no column to capability_registry at
-- all) -- behavioural re-check that the same nine classes remain
-- rejected on DIRECT single-admin writes too, not only through propose.
-- =========================================================================
do $$
declare forbidden text;
begin
  foreach forbidden in array array['payment', 'receipt', 'refund']
  loop
    begin
      perform app_private.staff_set_capability_registry_entry(
        'ctl12_ctl14_probe', forbidden, 'CTL-14 probe', false, 100, null, null, '{}'::jsonb, false, false, null, null
      );
      raise exception 'CTL-14: capacity_class % must still be rejected by the direct write path, unaffected by this migration', forbidden;
    exception when check_violation then null;
    end;
  end loop;
end
$$;

-- =========================================================================
-- CTL-15, re-asserted: no retention/TTL/expiry column anywhere in the
-- tables this migration's functions read or write. This migration adds
-- NO new table and NO new column (the six proposed_* columns already
-- existed, added by migration 0153) -- this scan re-confirms that
-- remains true.
-- =========================================================================
do $$
declare hit record; hit_count integer := 0;
begin
  for hit in
    select table_name, column_name
      from information_schema.columns
     where table_schema = 'public'
       and table_name in ('capability_registry', 'capability_change_requests', 'capability_change_approvals')
       and (column_name ~* 'retention' or column_name ~* 'retain' or column_name ~* 'ttl' or column_name ~* 'expir')
  loop
    hit_count := hit_count + 1;
    raise warning 'CTL-15: unexpected retention-shaped column %.%', hit.table_name, hit.column_name;
  end loop;
  if hit_count > 0 then
    raise exception 'CTL-15: % retention-shaped column(s) found', hit_count;
  end if;
end
$$;

-- =========================================================================
-- CTL-03, re-asserted: bsa_app still has zero table-level grant on
-- capability_registry or capability_change_requests/capability_change_
-- approvals -- this migration adds function grants only, no new
-- table-level grant anywhere.
-- =========================================================================
do $$
declare tbl record;
begin
  for tbl in
    select unnest(array[
      'public.capability_registry', 'public.capability_change_requests', 'public.capability_change_approvals'
    ]) as name
  loop
    if has_table_privilege('bsa_app', tbl.name, 'SELECT') then
      raise exception 'CTL-03: SELECT on % must remain revoked from bsa_app -- functions are the only reachable path', tbl.name;
    end if;
    if has_table_privilege('bsa_app', tbl.name, 'INSERT') then
      raise exception 'CTL-03: INSERT on % must remain revoked from bsa_app', tbl.name;
    end if;
    if has_table_privilege('bsa_app', tbl.name, 'UPDATE') then
      raise exception 'CTL-03: UPDATE on % must remain revoked from bsa_app', tbl.name;
    end if;
  end loop;
end
$$;

-- =========================================================================
-- NO SECOND PATH: the internal unguarded helper apply_due_capability_
-- change now calls (app_private.set_capability_registry_entry_unchecked,
-- migration 0155 Job 3a) remains unreachable directly -- revoked from
-- public, and NOT granted to bsa_app, exactly as 0155 shipped it. This
-- migration grants it to no one.
-- =========================================================================
do $$
declare sig text := 'app_private.set_capability_registry_entry_unchecked(text, text, text, boolean, integer, text, text, jsonb, boolean, boolean, text, text)';
begin
  if has_function_privilege('public', sig, 'execute') then
    raise exception 'NO SECOND PATH: execute on % must remain revoked from public', sig;
  end if;
  if has_function_privilege('bsa_app', sig, 'execute') then
    raise exception 'NO SECOND PATH: execute on % must remain NOT granted to bsa_app -- the running API must never be able to call the unguarded helper directly', sig;
  end if;
end
$$;

-- The single-admin route's own function must still reject an EXISTING
-- capability -- widening propose/apply did not reopen 0155's closed
-- bypass.
do $$
begin
  begin
    perform app_private.staff_set_capability_registry_entry(
      'ctl12_full_widget', 'active_widget', 'attempted single-admin bypass', false, 100, 'pro',
      null, '{}'::jsonb, false, false, null, null
    );
    raise exception 'NO SECOND PATH: staff_set_capability_registry_entry must still reject a call targeting an EXISTING capability after this migration';
  exception when insufficient_privilege then null;
  end;
end
$$;
