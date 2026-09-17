-- CTL registry spec alignment (migration 0153): bringing the capability
-- registry (0149) to FULL-PRODUCT-DEFINITION.md §20.2's declared field
-- set and §20.3's actual resolution order, without breaking 0149's
-- CTL-14/CTL-15 structural guards or 0152's change-management layer.
--
-- Covers:
--   * GAP 1 (§20.2 fields): kind, limits, beta, marketing_visible,
--     marketing_label, marketing_blurb are settable (staff_set_
--     capability_registry_entry) and readable (staff_get_/
--     staff_list_capability_registry_entries), staff-only, versioned and
--     audited through the SAME table-level triggers 0149's own CTL-01
--     proves fire regardless of write path;
--   * GAP 2 (§20.3 order): capability_allowlist is the missing
--     "on for this channel regardless of tier" inclusion stage,
--     evaluated after denylist and ahead of rollout/tier/override --
--     proven by leaving a LOWER-precedence rule (min_tier) in place and
--     showing allowlist still decides, and proven independently against
--     rollout-exclusion and against kill/denylist (allowlist beats
--     neither);
--   * CTL-14 (capacity_class closed whitelist) and CTL-15 (no
--     retention/TTL/expiry column anywhere) re-proven over the WIDENED
--     schema: the new capability_allowlist table, capability_registry's
--     six new columns, and capability_change_requests' six new columns;
--   * CTL-03 posture extended: capability_allowlist has no bsa_app
--     grant either; every new function is staff-only (is_platform_admin),
--     revoked from public, granted to bsa_app;
--   * 0152 still works: an ordinary (old-path) propose/approve/apply
--     cycle, entirely through 0152's own unmodified functions, still
--     preserves the new fields untouched; staff_kill_capability_now
--     still preserves them; staff_revert_capability_registry_entry (the
--     one 0152 function this migration touches, body-only) now restores
--     them correctly from the prior version's audit snapshot;
--   * exact returned column sets for every new function, asserted
--     against information_schema.parameters.
--
-- Fixture: own staff user '...6d00', channel '...6d01' (free tier,
-- reusing base_world owner '...0001' and its full member roster) --
-- pre-assigned fixture range ...6d00-...6dff (verified free against
-- packages/db/tests/fixtures/00_base_world.sql's own running note; grep
-- across packages/db/tests/*.sql found no existing ...6d00-...6dff
-- reference).
\set ON_ERROR_STOP on

insert into app_users (id, external_subject, display_name, created_at, updated_at, is_platform_admin)
values ('00000000-0000-4000-8000-000000006d00', 'google-ctl-spec-staff', 'CTL Spec Staff', current_timestamp, current_timestamp, true)
on conflict (id) do nothing;

insert into channels (id, owner_user_id, handle, display_name, accepting_tips, public_config_version, created_at, updated_at)
values ('00000000-0000-4000-8000-000000006d01', '00000000-0000-4000-8000-000000000001', 'ctl_spec_free', 'CTL Spec Free Channel', true, 1, current_timestamp, current_timestamp)
on conflict (id) do nothing;

insert into channel_memberships (channel_id, user_id, role, created_at)
values ('00000000-0000-4000-8000-000000006d01', '00000000-0000-4000-8000-000000000001', 'owner', current_timestamp)
on conflict (channel_id, user_id) do nothing;

insert into channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at)
values ('00000000-0000-4000-8000-000000006d01', 1, 'free', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp)
on conflict (channel_id, version) do nothing;

-- =========================================================================
-- STRUCTURAL: every new function revoked from public, granted to
-- bsa_app; capability_allowlist revoked from BOTH public and bsa_app
-- (CTL-03 posture extended to this new table).
-- =========================================================================
do $$
declare fn record;
begin
  for fn in
    select unnest(array[
      'app_private.staff_get_capability_registry_entry(text)',
      'app_private.staff_list_capability_registry_entries()',
      'app_private.staff_set_capability_registry_entry(text, text, text, boolean, integer, text, text, jsonb, boolean, boolean, text, text)',
      'app_private.staff_revert_capability_registry_entry(text, text)',
      'app_private.resolve_channel_capabilities(uuid)'
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

do $$
begin
  if has_table_privilege('public', 'public.capability_allowlist', 'SELECT') then
    raise exception 'SELECT on capability_allowlist must be revoked from public';
  end if;
  if has_table_privilege('bsa_app', 'public.capability_allowlist', 'SELECT') then
    raise exception 'CTL-03: SELECT on capability_allowlist must be revoked from bsa_app -- the resolved-blob function is the only reachable path, never a per-row/per-capability query';
  end if;
  if has_table_privilege('bsa_app', 'public.capability_allowlist', 'INSERT') then
    raise exception 'CTL-03: INSERT on capability_allowlist must be revoked from bsa_app';
  end if;
end
$$;

set role bsa_app;
do $$
begin
  begin
    perform 1 from public.capability_allowlist limit 1;
    raise exception 'CTL-03: bsa_app must not be able to SELECT capability_allowlist directly';
  exception when insufficient_privilege then
    null; -- expected
  end;
end
$$;
reset role;

-- =========================================================================
-- Non-staff rejected on every new function.
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false); -- channel owner, not staff

do $$
begin
  begin
    perform app_private.staff_set_capability_registry_entry(
      'ctl_spec_unauth_probe', 'team_seat', 'should be rejected', false, 100, null,
      'widget', '{}'::jsonb, false, false, null, null
    );
    raise exception 'a non-staff user must not be able to write via staff_set_capability_registry_entry';
  exception when insufficient_privilege then null;
  end;

  begin
    perform * from app_private.staff_get_capability_registry_entry('anything');
    raise exception 'a non-staff user must not be able to read via staff_get_capability_registry_entry';
  exception when insufficient_privilege then null;
  end;

  begin
    perform * from app_private.staff_list_capability_registry_entries();
    raise exception 'a non-staff user must not be able to read via staff_list_capability_registry_entries';
  exception when insufficient_privilege then null;
  end;
end
$$;

-- =========================================================================
-- GAP 1: every new §20.2 field is settable and readable.
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000006d00', false);

select * from app_private.staff_set_capability_registry_entry(
  'ctl_spec_full_widget', 'active_widget', 'A fully-specified §20.2 row', false, 100, 'pro',
  'widget', '{"max_instances": 3, "max_duration_ms": 8000}'::jsonb, true, true,
  'Wins This Season', 'Track your season record live on stream.'
);

do $$
declare
  v_kind text; v_limits jsonb; v_beta boolean; v_marketing_visible boolean;
  v_marketing_label text; v_marketing_blurb text; v_capacity_class text;
begin
  select kind, limits, beta, marketing_visible, marketing_label, marketing_blurb, capacity_class
    into v_kind, v_limits, v_beta, v_marketing_visible, v_marketing_label, v_marketing_blurb, v_capacity_class
    from app_private.staff_get_capability_registry_entry('ctl_spec_full_widget');

  if v_kind <> 'widget' then raise exception 'kind must round-trip, got %', v_kind; end if;
  if v_limits <> '{"max_instances": 3, "max_duration_ms": 8000}'::jsonb then
    raise exception 'limits must round-trip exactly, got %', v_limits;
  end if;
  if v_beta is not true then raise exception 'beta must round-trip true, got %', v_beta; end if;
  if v_marketing_visible is not true then raise exception 'marketing_visible must round-trip true, got %', v_marketing_visible; end if;
  if v_marketing_label <> 'Wins This Season' then raise exception 'marketing_label must round-trip, got %', v_marketing_label; end if;
  if v_marketing_blurb <> 'Track your season record live on stream.' then raise exception 'marketing_blurb must round-trip, got %', v_marketing_blurb; end if;
  -- capacity_class (CTL-14's own column) is untouched by this widening --
  -- still settable, still present, still the closed-whitelist concept.
  if v_capacity_class <> 'active_widget' then raise exception 'capacity_class must still round-trip via the new function, got %', v_capacity_class; end if;
end
$$;

-- limits ships EMPTY by default when not supplied (NULL -> '{}').
select * from app_private.staff_set_capability_registry_entry(
  'ctl_spec_default_limits', 'ai_usage', 'No limits value supplied', false, 100, null,
  null, null, null, null, null, null
);
do $$
declare v_limits jsonb; v_kind text; v_beta boolean; v_marketing_visible boolean;
begin
  select limits, kind, beta, marketing_visible into v_limits, v_kind, v_beta, v_marketing_visible
    from app_private.staff_get_capability_registry_entry('ctl_spec_default_limits');
  if v_limits <> '{}'::jsonb then raise exception 'limits must default to {} when not supplied, got %', v_limits; end if;
  if v_kind is not null then raise exception 'kind must stay null when not supplied, got %', v_kind; end if;
  if v_beta is not false then raise exception 'beta must default to false when not supplied, got %', v_beta; end if;
  if v_marketing_visible is not false then raise exception 'marketing_visible must default to false when not supplied, got %', v_marketing_visible; end if;
end
$$;

-- kind: invalid value rejected, structurally.
do $$
begin
  begin
    perform app_private.staff_set_capability_registry_entry(
      'ctl_spec_bad_kind', 'team_seat', 'bad kind', false, 100, null,
      'marketing_section', '{}'::jsonb, false, false, null, null
    );
    raise exception 'an unrecognised kind must be rejected -- §20.2''s enum does not contain marketing_section (see this migration''s own header)';
  exception when check_violation then null;
  end;
end
$$;

-- marketing_visible=true without label/blurb rejected -- the structural
-- safeguard added alongside the marketing fields.
do $$
begin
  begin
    perform app_private.staff_set_capability_registry_entry(
      'ctl_spec_bad_marketing', 'team_seat', 'visible with no copy', false, 100, null,
      'feature', '{}'::jsonb, false, true, null, null
    );
    raise exception 'marketing_visible=true with no label/blurb must be rejected';
  exception when check_violation then null;
  end;
end
$$;

-- staff_list_capability_registry_entries includes every row set above.
do $$
declare v_count integer;
begin
  select count(*) into v_count from app_private.staff_list_capability_registry_entries()
   where capability_key in ('ctl_spec_full_widget', 'ctl_spec_default_limits');
  if v_count <> 2 then raise exception 'staff_list_capability_registry_entries must list both rows, got %', v_count; end if;
end
$$;

-- =========================================================================
-- staff_upsert_capability_registry_entry (0149's ORIGINAL function) is
-- untouched: still exactly its original 6-arg/8-column shape, still
-- usable, and an update through it leaves the new fields alone (it
-- never mentions them in its own SET clause) -- proves the "two write
-- paths, one table, same triggers" design does not regress the
-- original path at all.
-- =========================================================================
select * from app_private.staff_upsert_capability_registry_entry(
  'ctl_spec_full_widget', 'active_widget', 'A fully-specified row (touched via the ORIGINAL function)', false, 100, 'creator'
);
do $$
declare v_kind text; v_beta boolean; v_marketing_visible boolean; v_description text;
begin
  select kind, beta, marketing_visible, description
    into v_kind, v_beta, v_marketing_visible, v_description
    from app_private.staff_get_capability_registry_entry('ctl_spec_full_widget');
  if v_description <> 'A fully-specified row (touched via the ORIGINAL function)' then
    raise exception 'the original function must still update the fields it owns, got %', v_description;
  end if;
  if v_kind <> 'widget' then raise exception 'the original function must leave kind untouched, got %', v_kind; end if;
  if v_beta is not true then raise exception 'the original function must leave beta untouched, got %', v_beta; end if;
  if v_marketing_visible is not true then raise exception 'the original function must leave marketing_visible untouched, got %', v_marketing_visible; end if;
end
$$;

-- =========================================================================
-- GAP 2: the allowlist stage. Two capabilities:
--   * ctl_spec_studio_gated: min_tier studio, rollout 100 (never
--     rollout-excluded) -- isolates the tier stage.
--   * ctl_spec_rollout_gated: min_tier null (always tier-eligible),
--     rollout 0 (always rollout-excluded) -- isolates the rollout stage.
-- Channel 6d01 is free tier.
-- =========================================================================
select * from app_private.staff_set_capability_registry_entry(
  'ctl_spec_studio_gated', 'automation_volume', 'Studio-gated, for the allowlist-vs-tier proof', false, 100, 'studio',
  null, null, null, null, null, null
);
select * from app_private.staff_set_capability_registry_entry(
  'ctl_spec_rollout_gated', 'ai_usage', 'Rollout-excluded, for the allowlist-vs-rollout proof', false, 0, null,
  null, null, null, null, null, null
);

select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false); -- channel 6d01's owner, a member read

-- BASELINE: the lower-precedence rule (min_tier) decides, with no
-- allowlist row yet -- a free-tier channel fails a studio-gated
-- capability.
do $$
declare v boolean;
begin
  select (resolved->>'ctl_spec_studio_gated')::boolean into v
    from app_private.get_channel_capabilities('00000000-0000-4000-8000-000000006d01'::uuid);
  if v is not false then raise exception 'BASELINE: a free-tier channel must fail a studio-gated capability with no allowlist entry, got %', v; end if;
end
$$;

-- BASELINE: rollout excludes with no allowlist row yet.
do $$
declare v boolean;
begin
  select (resolved->>'ctl_spec_rollout_gated')::boolean into v
    from app_private.get_channel_capabilities('00000000-0000-4000-8000-000000006d01'::uuid);
  if v is not false then raise exception 'BASELINE: rollout_percentage=0 must exclude with no allowlist entry, got %', v; end if;
end
$$;

-- ALLOWLIST BEATS TIER: the min_tier rule (lower precedence, §20.3 step
-- 4) stays in place, untouched -- the allowlist entry (higher
-- precedence, step 3) is what flips the answer.
insert into public.capability_allowlist (capability_key, channel_id)
values ('ctl_spec_studio_gated', '00000000-0000-4000-8000-000000006d01');

do $$
declare v boolean; v_min_tier text;
begin
  select (resolved->>'ctl_spec_studio_gated')::boolean into v
    from app_private.get_channel_capabilities('00000000-0000-4000-8000-000000006d01'::uuid);
  if v is not true then raise exception '§20.3: an allowlisted channel must be entitled regardless of tier, got %', v; end if;

  perform set_config('app.user_id', '00000000-0000-4000-8000-000000006d00', false);
  select min_tier into v_min_tier from app_private.staff_get_capability_registry_entry('ctl_spec_studio_gated');
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);
  if v_min_tier <> 'studio' then raise exception 'the lower-precedence rule must still be in place, unchanged (min_tier=studio), got %', v_min_tier; end if;
end
$$;

-- ALLOWLIST BEATS ROLLOUT-EXCLUSION too (§20.3 groups them as one
-- "on regardless of tier" step; an explicit per-channel grant bypasses
-- the percentage bucket the same way it bypasses tier).
insert into public.capability_allowlist (capability_key, channel_id)
values ('ctl_spec_rollout_gated', '00000000-0000-4000-8000-000000006d01');

do $$
declare v boolean;
begin
  select (resolved->>'ctl_spec_rollout_gated')::boolean into v
    from app_private.get_channel_capabilities('00000000-0000-4000-8000-000000006d01'::uuid);
  if v is not true then raise exception 'an allowlisted channel must be entitled despite rollout_percentage=0, got %', v; end if;
end
$$;

-- ALLOWLIST NEVER BEATS DENYLIST (denylist is strictly higher
-- precedence, §20.3 step 2 vs step 3) -- both mechanisms active on the
-- SAME channel/capability, denylist still decides.
select set_config('app.user_id', '00000000-0000-4000-8000-000000006d00', false);
insert into public.capability_denylist (capability_key, channel_id)
values ('ctl_spec_studio_gated', '00000000-0000-4000-8000-000000006d01');
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);

do $$
declare v boolean;
begin
  select (resolved->>'ctl_spec_studio_gated')::boolean into v
    from app_private.get_channel_capabilities('00000000-0000-4000-8000-000000006d01'::uuid);
  if v is not false then raise exception 'denylist must still beat an active allowlist entry (denylist is higher precedence), got %', v; end if;
end
$$;

-- ALLOWLIST NEVER BEATS KILL either (kill is the absolute first stage).
-- MIGRATION 0155, Job 3: staff_set_capability_registry_entry now
-- rejects any call targeting an EXISTING capability (single-admin
-- writes are permitted only to CREATE a new one -- see 0155's own
-- header). 'ctl_spec_studio_gated' already exists (set above), so this
-- probe switches to app_private.staff_kill_capability_now (0152's own
-- single-admin kill path, untouched by Job 3 -- it calls 0149's
-- staff_upsert_capability_registry_entry, a different function
-- entirely) to engage the kill switch instead. That function preserves
-- every field it does not itself mention (capacity_class/description/
-- rollout_percentage/min_tier, read from the current row), so this
-- substitution is behaviourally equivalent for what this test checks.
select set_config('app.user_id', '00000000-0000-4000-8000-000000006d00', false);
delete from public.capability_denylist where capability_key = 'ctl_spec_studio_gated' and channel_id = '00000000-0000-4000-8000-000000006d01';
select * from app_private.staff_kill_capability_now('ctl_spec_studio_gated', 'kill switch engaged');
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);

do $$
declare v boolean;
begin
  select (resolved->>'ctl_spec_studio_gated')::boolean into v
    from app_private.get_channel_capabilities('00000000-0000-4000-8000-000000006d01'::uuid);
  if v is not false then raise exception 'kill must still beat an active allowlist entry (kill is absolute, evaluated first), got %', v; end if;
end
$$;

-- =========================================================================
-- 0152 STILL WORKS, path 1: an ordinary (old-path) propose/approve/
-- apply cycle -- entirely through 0152's own UNMODIFIED functions --
-- must still preserve the new fields it never even mentions.
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000006d00', false);

-- TWO more staff users are required -- CTL-07's maker-checker rejects
-- the proposer approving their own change, and two DISTINCT staff
-- approvals are required regardless, so neither approver may be
-- '...6d00' (the proposer below).
insert into app_users (id, external_subject, display_name, created_at, updated_at, is_platform_admin)
values
  ('00000000-0000-4000-8000-000000006d0a', 'google-ctl-spec-staff-2', 'CTL Spec Staff 2', current_timestamp, current_timestamp, true),
  ('00000000-0000-4000-8000-000000006d0b', 'google-ctl-spec-staff-3', 'CTL Spec Staff 3', current_timestamp, current_timestamp, true)
on conflict (id) do nothing;

do $$
declare v_id uuid;
begin
  -- 'ctl_spec_full_widget' currently sits at min_tier 'creator' (a paid
  -- tier, set earlier in this file) -- proposing 'pro' here is a
  -- paid-to-paid move, deliberately NOT a paid->Free move, so this stays
  -- an ORDINARY two-staff change with no CTL-07 rule 2 owner sign-off
  -- requirement, matching the plain "unstaged update" case this probe is
  -- for.
  select id into v_id from app_private.staff_propose_capability_change(
    'ctl_spec_full_widget', 'active_widget', 'ordinary tier change, old propose path', false, 100, 'pro', null, 'old-path regression probe'
  );

  perform set_config('app.user_id', '00000000-0000-4000-8000-000000006d0a', false);
  perform app_private.staff_approve_capability_change(v_id, 'staff');
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000006d0b', false);
  perform app_private.staff_approve_capability_change(v_id, 'staff');
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000006d00', false);
end
$$;

do $$
declare v_status text; v_kind text; v_beta boolean; v_marketing_visible boolean; v_min_tier text;
begin
  select status into v_status from public.capability_change_requests
   where capability_key = 'ctl_spec_full_widget' and reason = 'old-path regression probe';
  if v_status <> 'applied' then raise exception 'an unstaged change must already be applied after its second approval, got %', v_status; end if;

  select kind, beta, marketing_visible, min_tier
    into v_kind, v_beta, v_marketing_visible, v_min_tier
    from app_private.staff_get_capability_registry_entry('ctl_spec_full_widget');
  if v_min_tier <> 'pro' then raise exception '0152''s own apply must still take effect for the fields it knows about, got min_tier %', v_min_tier; end if;
  if v_kind <> 'widget' then raise exception '0152''s unmodified apply path must PRESERVE kind (it never mentions this column), got %', v_kind; end if;
  if v_beta is not true then raise exception '0152''s unmodified apply path must PRESERVE beta, got %', v_beta; end if;
  if v_marketing_visible is not true then raise exception '0152''s unmodified apply path must PRESERVE marketing_visible, got %', v_marketing_visible; end if;
end
$$;

-- =========================================================================
-- 0152 STILL WORKS, path 2: staff_kill_capability_now preserves the new
-- fields (unmodified function, unlisted columns in its own SET clause).
-- =========================================================================
select * from app_private.staff_kill_capability_now('ctl_spec_full_widget', 'kill regression probe');

do $$
declare v_kind text; v_beta boolean; v_kill boolean;
begin
  select kind, beta, kill_switch into v_kind, v_beta, v_kill from app_private.staff_get_capability_registry_entry('ctl_spec_full_widget');
  if v_kill is not true then raise exception 'kill must still set kill_switch, got %', v_kill; end if;
  if v_kind <> 'widget' then raise exception 'kill must PRESERVE kind, got %', v_kind; end if;
  if v_beta is not true then raise exception 'kill must PRESERVE beta, got %', v_beta; end if;
end
$$;

-- Lift the kill so the revert test below is not confounded by it.
-- MIGRATION 0155, Job 3: staff_set_capability_registry_entry now
-- rejects any call targeting an EXISTING capability -- 'ctl_spec_full_
-- widget' already exists, and this step needs full ad hoc control over
-- every §20.2 field (not just kill_switch, which staff_kill_capability_
-- now/staff_revert_capability_registry_entry would give), purely to
-- construct a specific intermediate STATE for the CTL-08 revert proof
-- below. It therefore calls app_private.set_capability_registry_entry_
-- unchecked directly -- the internal, ungoverned helper Job 3
-- introduced, reachable here only because this test file runs as the
-- database superuser (which bypasses the REVOKE the same way it already
-- bypasses the table-level REVOKEs this file relies on elsewhere, e.g.
-- the direct `insert into public.capability_allowlist` above). This
-- does not exercise, and does not weaken, the PUBLIC guarded entry
-- point's new gate -- that gate is proven directly, both positively
-- (new capability succeeds) and negatively (existing capability
-- rejected), in packages/db/tests/ctl_emergency_kill_and_owner.sql.
select * from app_private.set_capability_registry_entry_unchecked(
  'ctl_spec_full_widget', 'active_widget', 'kill lifted before revert test', false, 100, 'free',
  'widget', '{"max_instances": 3, "max_duration_ms": 8000}'::jsonb, true, true,
  'Wins This Season', 'Track your season record live on stream.'
);

-- =========================================================================
-- 0152 STILL WORKS, path 3: CTL-08 revert (the ONE 0152 function this
-- migration touches) now restores kind/limits/beta/marketing_* from the
-- immediately-previous version -- not just capacity_class/description/
-- kill_switch/rollout_percentage/min_tier. (Migration 0155 also touches
-- staff_revert_capability_registry_entry, body-only, to call the new
-- internal helper instead of the now-guarded public one -- see 0155's
-- own Job 3 header. Its signature/output and restore semantics are
-- otherwise identical, so this proof still holds unchanged.)
-- =========================================================================
select * from app_private.set_capability_registry_entry_unchecked(
  'ctl_spec_full_widget', 'active_widget', 'about to be reverted', false, 100, 'free',
  'module', '{"max_instances": 9}'::jsonb, false, false, null, null
);

do $$
declare v_version integer;
begin
  select version into v_version from app_private.staff_get_capability_registry_entry('ctl_spec_full_widget');
  raise notice 'ctl_spec_full_widget is now version %', v_version;
end
$$;

select * from app_private.staff_revert_capability_registry_entry('ctl_spec_full_widget', 'revert regression probe');

do $$
declare
  v_kind text; v_limits jsonb; v_beta boolean; v_marketing_visible boolean;
  v_marketing_label text; v_marketing_blurb text; v_description text;
begin
  select kind, limits, beta, marketing_visible, marketing_label, marketing_blurb, description
    into v_kind, v_limits, v_beta, v_marketing_visible, v_marketing_label, v_marketing_blurb, v_description
    from app_private.staff_get_capability_registry_entry('ctl_spec_full_widget');

  if v_description <> 'kill lifted before revert test' then
    raise exception 'CTL-08: revert must restore the immediately-previous description, got %', v_description;
  end if;
  if v_kind <> 'widget' then raise exception 'CTL-08: revert must restore kind, got %', v_kind; end if;
  if v_limits <> '{"max_instances": 3, "max_duration_ms": 8000}'::jsonb then
    raise exception 'CTL-08: revert must restore limits, got %', v_limits;
  end if;
  if v_beta is not true then raise exception 'CTL-08: revert must restore beta, got %', v_beta; end if;
  if v_marketing_visible is not true then raise exception 'CTL-08: revert must restore marketing_visible, got %', v_marketing_visible; end if;
  if v_marketing_label <> 'Wins This Season' then raise exception 'CTL-08: revert must restore marketing_label, got %', v_marketing_label; end if;
  if v_marketing_blurb <> 'Track your season record live on stream.' then raise exception 'CTL-08: revert must restore marketing_blurb, got %', v_marketing_blurb; end if;
end
$$;

-- The revert's own change-request row also carries the restored §20.2
-- fields (capability_change_requests.proposed_kind etc, migration
-- 0153) -- not just the original five.
do $$
declare v_proposed_kind text; v_proposed_beta boolean;
begin
  select proposed_kind, proposed_beta into v_proposed_kind, v_proposed_beta
    from public.capability_change_requests
   where capability_key = 'ctl_spec_full_widget' and change_kind = 'revert'
   order by created_at desc limit 1;
  if v_proposed_kind <> 'widget' then raise exception 'the revert''s own change-request row must record proposed_kind, got %', v_proposed_kind; end if;
  if v_proposed_beta is not true then raise exception 'the revert''s own change-request row must record proposed_beta, got %', v_proposed_beta; end if;
end
$$;

-- =========================================================================
-- CTL-14, RE-PROVEN over the widened schema: the same nine §12.6.1
-- forbidden classes, rejected via the NEW write function too (not just
-- the original one 0149's own test already covers).
-- =========================================================================
do $$
declare forbidden text; probe_key text;
begin
  foreach forbidden in array array[
    'payment', 'receipt', 'refund', 'audit_trail', 'supporter_relationship',
    'event_history', 'configuration', 'layout', 'moderation_history'
  ]
  loop
    probe_key := 'ctl_spec_ctl14_probe_' || forbidden;
    begin
      perform app_private.staff_set_capability_registry_entry(
        probe_key, forbidden, 'CTL-14 probe via the widened write function', false, 100, 'studio',
        'widget', '{}'::jsonb, false, false, null, null
      );
      raise exception 'CTL-14: capacity_class % must still be rejected via staff_set_capability_registry_entry', forbidden;
    exception when check_violation then null;
    end;
  end loop;

  perform 1 from public.capability_registry where capability_key like 'ctl_spec_ctl14_probe_%';
  if found then raise exception 'CTL-14: a probe row was persisted despite the expected check_violation'; end if;
end
$$;

do $$
declare definition text; forbidden text;
begin
  select pg_catalog.pg_get_constraintdef(c.oid)
    into definition
    from pg_catalog.pg_constraint c
    join pg_catalog.pg_class t on t.oid = c.conrelid
   where t.relname = 'capability_registry' and c.conname = 'capability_registry_capacity_class_check';

  if definition is null then
    raise exception 'CTL-14: capability_registry_capacity_class_check does not exist -- the structural guard has been removed';
  end if;

  foreach forbidden in array array[
    'payment', 'receipt', 'refund', 'audit_trail', 'supporter_relationship',
    'event_history', 'configuration', 'layout', 'moderation_history', 'durable', 'record'
  ]
  loop
    if position(forbidden in definition) > 0 then
      raise exception 'CTL-14: capacity_class''s whitelist must never contain "%", even after widening the table around it', forbidden;
    end if;
  end loop;
end
$$;

-- Also confirm `kind`'s own new enum does not, itself, become a second
-- way to smuggle a durable-record concept in -- it is a DIFFERENT
-- taxonomy (§20.2, capability TYPE) from capacity_class (§12.6.1,
-- active-capacity CONCEPT), but the same nine forbidden tokens must
-- never appear in it either.
do $$
declare definition text; forbidden text;
begin
  select pg_catalog.pg_get_constraintdef(c.oid)
    into definition
    from pg_catalog.pg_constraint c
    join pg_catalog.pg_class t on t.oid = c.conrelid
   where t.relname = 'capability_registry' and c.conname = 'capability_registry_kind_check';

  if definition is null then
    raise exception 'kind''s own check constraint does not exist';
  end if;

  foreach forbidden in array array[
    'payment', 'receipt', 'refund', 'audit_trail', 'supporter_relationship',
    'event_history', 'configuration', 'layout', 'moderation_history'
  ]
  loop
    if position(forbidden in definition) > 0 then
      raise exception 'kind''s enum must never contain "%" either', forbidden;
    end if;
  end loop;
end
$$;

-- =========================================================================
-- CTL-15, RE-PROVEN over the widened schema: capability_registry's six
-- new columns, capability_allowlist (new table), and
-- capability_change_requests' six new columns -- no retention/TTL/expiry
-- column anywhere.
-- =========================================================================
do $$
declare hit record; hit_count integer := 0;
begin
  for hit in
    select table_name, column_name
      from information_schema.columns
     where table_schema = 'public'
       and table_name in (
         'capability_registry', 'capability_registry_audit', 'capability_denylist',
         'capability_overrides', 'capability_registry_generation', 'capability_resolutions',
         'capability_allowlist', 'capability_change_requests', 'capability_change_approvals'
       )
       and (
         column_name ~* 'retention' or column_name ~* 'retain'
         or column_name ~* 'ttl' or column_name ~* 'expir'
       )
  loop
    hit_count := hit_count + 1;
    raise warning 'CTL-15: forbidden column %.%', hit.table_name, hit.column_name;
  end loop;
  if hit_count > 0 then
    raise exception 'CTL-15: % retention-shaped column(s) found across the widened schema', hit_count;
  end if;
end
$$;

-- =========================================================================
-- STRUCTURAL: exact returned column sets for every new function.
-- =========================================================================
do $$
declare actual text; expected text;
begin
  expected := 'capability_key,capacity_class,description,kill_switch,rollout_percentage,min_tier,kind,limits,beta,marketing_visible,marketing_label,marketing_blurb,version,created_at,updated_at,updated_by';

  select string_agg(p.parameter_name, ',' order by p.ordinal_position) into actual
    from information_schema.parameters p
    join information_schema.routines r
      on r.specific_name = p.specific_name and r.specific_schema = p.specific_schema
   where r.routine_schema = 'app_private' and r.routine_name = 'staff_get_capability_registry_entry' and p.parameter_mode = 'OUT';
  if actual is distinct from expected then
    raise exception 'staff_get_capability_registry_entry must project exactly %. Found: %', expected, coalesce(actual, '<none>');
  end if;

  select string_agg(p.parameter_name, ',' order by p.ordinal_position) into actual
    from information_schema.parameters p
    join information_schema.routines r
      on r.specific_name = p.specific_name and r.specific_schema = p.specific_schema
   where r.routine_schema = 'app_private' and r.routine_name = 'staff_list_capability_registry_entries' and p.parameter_mode = 'OUT';
  if actual is distinct from expected then
    raise exception 'staff_list_capability_registry_entries must project exactly %. Found: %', expected, coalesce(actual, '<none>');
  end if;
end
$$;

do $$
declare actual text; expected text;
begin
  expected := 'capability_key,capacity_class,description,kill_switch,rollout_percentage,min_tier,kind,limits,beta,marketing_visible,marketing_label,marketing_blurb,version,updated_at';
  select string_agg(p.parameter_name, ',' order by p.ordinal_position) into actual
    from information_schema.parameters p
    join information_schema.routines r
      on r.specific_name = p.specific_name and r.specific_schema = p.specific_schema
   where r.routine_schema = 'app_private' and r.routine_name = 'staff_set_capability_registry_entry' and p.parameter_mode = 'OUT';
  if actual is distinct from expected then
    raise exception 'staff_set_capability_registry_entry must project exactly %. Found: %', expected, coalesce(actual, '<none>');
  end if;
end
$$;

-- resolve_channel_capabilities / get_channel_capabilities: UNCHANGED
-- output (0149's own assertion already covers this exact string in
-- ctl_capability_registry.sql; re-asserted here too, against the
-- POST-migration function, as this file's own independent proof it
-- really did not change).
do $$
declare actual text;
begin
  select string_agg(p.parameter_name, ',' order by p.ordinal_position) into actual
    from information_schema.parameters p
    join information_schema.routines r
      on r.specific_name = p.specific_name and r.specific_schema = p.specific_schema
   where r.routine_schema = 'app_private' and r.routine_name = 'resolve_channel_capabilities' and p.parameter_mode = 'OUT';
  if actual is distinct from 'resolved,generation,resolved_at' then
    raise exception 'resolve_channel_capabilities must still project exactly resolved,generation,resolved_at after widening its body. Found: %', coalesce(actual, '<none>');
  end if;
end
$$;

-- =========================================================================
-- Negative: staff_set_capability_registry_entry rejects invalid
-- min_tier/rollout/capability_key the same way the original function
-- does (the same table-level constraints, shared by both write paths).
-- =========================================================================
do $$
begin
  begin
    perform app_private.staff_set_capability_registry_entry(
      'ctl_spec_bad_tier', 'team_seat', 'bad tier', false, 100, 'enterprise',
      'widget', '{}'::jsonb, false, false, null, null
    );
    raise exception 'an unrecognised min_tier must be rejected via staff_set_capability_registry_entry too';
  exception when check_violation then null;
  end;

  begin
    perform app_private.staff_set_capability_registry_entry(
      'Not_A_Valid_Key', 'team_seat', 'bad key shape', false, 100, null,
      'widget', '{}'::jsonb, false, false, null, null
    );
    raise exception 'an uppercase capability_key must be rejected via staff_set_capability_registry_entry too';
  exception when check_violation then null;
  end;
end
$$;
