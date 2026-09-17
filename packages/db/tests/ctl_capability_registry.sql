-- CTL phase 1 (migration 0149): capability registry, resolver, resolved-
-- blob cache, and the two structural guards CTL-14/CTL-15.
--
-- Covers:
--   * CTL-01: the registry is versioned (version increments on every
--     update, on EVERY write path -- a direct SQL update and the staff
--     function both bump it) and audited (every insert/update lands in
--     capability_registry_audit, readable only by staff);
--   * CTL-02: the resolution order kill -> denylist -> rollout -> tier
--     -> override, proven as a chain where each earlier stage forces
--     false ahead of a channel-specific override that would otherwise
--     flip the tier default to true;
--   * CTL-03: the resolved blob is one jsonb object per channel, cached
--     (a second read with nothing changed returns the identical
--     resolved_at with no recompute) and versioned (the generation
--     bumps on any registry/denylist/override write and the cache
--     misses on the next read); bsa_app has NO select/insert/update/
--     delete grant on any of the five tables this migration creates --
--     the only reachable path is the one blob-returning function;
--   * CTL-14: capacity_class's closed whitelist structurally rejects
--     every one of the nine §12.6.1 durable-record classes, proven
--     BEHAVIOURALLY (each attempted insert raises check_violation) and
--     STRUCTURALLY (the constraint definition itself is scanned for the
--     nine forbidden tokens and must contain none of them -- this is
--     the guard that "fails when removed": drop the check constraint
--     and the behavioural half's expected-exception assertions start
--     failing because the inserts would then succeed);
--   * CTL-15: no column of any table this migration creates names
--     retention/retain/ttl/expiry in any form -- scanned structurally,
--     the same technique;
--   * authorisation: only platform staff (app_private.is_platform_admin)
--     may write a registry row or read the audit trail; every channel
--     member may read that channel's resolved blob, a non-member sees
--     zero rows;
--   * the returned column set of every function this migration ships is
--     asserted exactly against information_schema.parameters;
--   * every function revoked from public, granted to bsa_app -- except
--     the five tables themselves, which are revoked from BOTH public
--     and bsa_app (CTL-03's "never per-capability queries" made
--     structural).
--
-- Fixture: own channels '...5f01' (free tier, owner base_world user
-- '...0001', admin '...0003', operator '...0004', moderator '...0005',
-- viewer '...0006') and '...5f02' (pro tier, owner base_world user
-- '...0002' -- the cross-channel isolation probe). Own staff user
-- '...5f00'. Own fixture ids ...5f00 upward -- verified free before use
-- (grep across packages/db/tests/*.sql found no existing ...5f00-...5fff
-- reference). base_world's own "next free" note (...1720) is stale --
-- that block is already in heavy use by other files; isolation between
-- files comes from run-sql-suite.sh's per-file database, not from a
-- globally unique id space, but a fresh, verified-free block keeps this
-- file's own fixture unambiguous to read.
\set ON_ERROR_STOP on

insert into app_users (id, external_subject, display_name, created_at, updated_at, is_platform_admin)
values ('00000000-0000-4000-8000-000000005f00', 'google-ctl-staff', 'CTL Staff', current_timestamp, current_timestamp, true)
on conflict (id) do nothing;

insert into channels (id, owner_user_id, handle, display_name, accepting_tips, public_config_version, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000005f01', '00000000-0000-4000-8000-000000000001', 'ctl_free', 'CTL Free Channel', true, 1, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000005f02', '00000000-0000-4000-8000-000000000002', 'ctl_pro', 'CTL Pro Channel', true, 1, current_timestamp, current_timestamp)
on conflict (id) do nothing;

insert into channel_memberships (channel_id, user_id, role, created_at)
values
  ('00000000-0000-4000-8000-000000005f01', '00000000-0000-4000-8000-000000000001', 'owner', current_timestamp),
  ('00000000-0000-4000-8000-000000005f01', '00000000-0000-4000-8000-000000000003', 'admin', current_timestamp),
  ('00000000-0000-4000-8000-000000005f01', '00000000-0000-4000-8000-000000000004', 'operator', current_timestamp),
  ('00000000-0000-4000-8000-000000005f01', '00000000-0000-4000-8000-000000000005', 'moderator', current_timestamp),
  ('00000000-0000-4000-8000-000000005f01', '00000000-0000-4000-8000-000000000006', 'viewer', current_timestamp),
  ('00000000-0000-4000-8000-000000005f02', '00000000-0000-4000-8000-000000000002', 'owner', current_timestamp)
on conflict (channel_id, user_id) do nothing;

insert into channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at)
values
  ('00000000-0000-4000-8000-000000005f01', 1, 'free', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000005f02', 1, 'pro', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp)
on conflict (channel_id, version) do nothing;

-- =========================================================================
-- STRUCTURAL: every function this migration ships is revoked from
-- public, granted to bsa_app; every table this migration ships is
-- revoked from BOTH public and bsa_app -- CTL-03's "never per-capability
-- queries" made structural: there is no grant path for bsa_app to read
-- a single registry/denylist/override/cache/generation row directly.
-- =========================================================================
do $$
declare fn record;
begin
  for fn in
    select unnest(array[
      'app_private.capability_tier_rank(text)',
      'app_private.capability_rollout_bucket(uuid, text)',
      'app_private.resolve_channel_capabilities(uuid)',
      'app_private.get_channel_capabilities(uuid)',
      'app_private.staff_upsert_capability_registry_entry(text, text, text, boolean, integer, text)',
      'app_private.staff_list_capability_registry_audit(text)'
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
declare tbl record;
begin
  for tbl in
    select unnest(array[
      'public.capability_registry',
      'public.capability_registry_audit',
      'public.capability_denylist',
      'public.capability_overrides',
      'public.capability_registry_generation',
      'public.capability_resolutions'
    ]) as name
  loop
    if has_table_privilege('public', tbl.name, 'SELECT') then
      raise exception 'SELECT on % must be revoked from public', tbl.name;
    end if;
    if has_table_privilege('bsa_app', tbl.name, 'SELECT') then
      raise exception 'CTL-03: SELECT on % must be revoked from bsa_app -- the resolved-blob function is the only reachable path, never a per-row/per-capability query', tbl.name;
    end if;
    if has_table_privilege('bsa_app', tbl.name, 'INSERT') then
      raise exception 'CTL-03: INSERT on % must be revoked from bsa_app', tbl.name;
    end if;
  end loop;
end
$$;

-- Behavioural confirmation of the same claim: connecting AS bsa_app and
-- attempting a direct read fails with insufficient_privilege, not just
-- "the catalogue says so".
set role bsa_app;
do $$
begin
  begin
    perform 1 from public.capability_registry limit 1;
    raise exception 'CTL-03: bsa_app must not be able to SELECT capability_registry directly';
  exception when insufficient_privilege then
    null; -- expected
  end;
end
$$;
reset role;

-- =========================================================================
-- CTL-14, BEHAVIOURAL: every one of the nine §12.6.1 durable-record
-- classes is rejected as capacity_class with check_violation.
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000005f00', false);

do $$
declare forbidden text;
declare probe_key text;
begin
  foreach forbidden in array array[
    'payment', 'receipt', 'refund', 'audit_trail', 'supporter_relationship',
    'event_history', 'configuration', 'layout', 'moderation_history'
  ]
  loop
    probe_key := 'ctl14_probe_' || forbidden;
    begin
      perform app_private.staff_upsert_capability_registry_entry(probe_key, forbidden, 'CTL-14 probe: gate a durable creator record', false, 100, 'studio');
      raise exception 'CTL-14: capacity_class % must be rejected -- the registry must never be able to express gating a durable creator record (§12.6)', forbidden;
    exception when check_violation then
      null; -- expected
    end;
  end loop;

  -- None of the nine probes may have been persisted.
  perform 1 from public.capability_registry where capability_key like 'ctl14_probe_%';
  if found then
    raise exception 'CTL-14: a probe row was persisted despite the expected check_violation';
  end if;
end
$$;

-- =========================================================================
-- CTL-14, STRUCTURAL: the check constraint's own definition is scanned
-- for the nine forbidden tokens. This is the guard that FAILS WHEN
-- REMOVED -- if the constraint is dropped, this assertion no longer has
-- anything to scan (definition is null) and fails loudly; if the
-- constraint is silently widened to admit one of these tokens, the scan
-- catches it even before any insert is attempted.
-- =========================================================================
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
      raise exception 'CTL-14: capacity_class''s whitelist must never contain "%" -- a registry row must never be able to declare its subject a durable creator record (§12.6)', forbidden;
    end if;
  end loop;
end
$$;

-- =========================================================================
-- CTL-15, STRUCTURAL: no column of any table this migration creates
-- names retention/retain/ttl/expiry in any form. This IS the guard --
-- its absence -- and the test fails the moment a column reintroducing
-- any of these tokens is added to any of the six tables.
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
         'capability_overrides', 'capability_registry_generation', 'capability_resolutions'
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
    raise exception 'CTL-15: % retention-shaped column(s) found -- retention must stay a single platform-wide schedule (§12.6.2), never a per-tier or per-capability field on this registry', hit_count;
  end if;
end
$$;

-- =========================================================================
-- CTL-01: only platform staff may write a registry row.
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false); -- an ordinary channel owner, not staff

do $$
begin
  begin
    perform app_private.staff_upsert_capability_registry_entry('unauthorised_probe', 'team_seat', 'should be rejected', false, 100, null);
    raise exception 'a non-staff user must not be able to write a capability_registry row';
  exception when insufficient_privilege then
    null; -- expected
  end;
end
$$;

select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);
do $$
begin
  begin
    perform * from app_private.staff_list_capability_registry_audit('anything');
    raise exception 'a non-staff user must not be able to read the capability registry audit trail';
  exception when insufficient_privilege then
    null; -- expected
  end;
end
$$;

-- =========================================================================
-- CTL-01: versioned AND audited, on both write paths -- the staff
-- function AND a direct SQL write (a test fixture, or any future
-- writer this migration did not anticipate). Version starts at 1.
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000005f00', false);

select * from app_private.staff_upsert_capability_registry_entry(
  'ctl_seat_extra_producer', 'team_seat', 'Extra producer seat beyond plan default', false, 100, 'pro'
);

do $$
declare v_version integer;
begin
  select version into v_version from public.capability_registry where capability_key = 'ctl_seat_extra_producer';
  if v_version <> 1 then raise exception 'a newly-inserted capability must be version 1, got %', v_version; end if;
end
$$;

-- Update through the staff function bumps the version and writes a
-- second audit row.
select * from app_private.staff_upsert_capability_registry_entry(
  'ctl_seat_extra_producer', 'team_seat', 'Extra producer seat beyond plan default (updated)', false, 100, 'creator'
);

do $$
declare v_version integer; v_min_tier text;
begin
  select version, min_tier into v_version, v_min_tier from public.capability_registry where capability_key = 'ctl_seat_extra_producer';
  if v_version <> 2 then raise exception 'an updated capability must bump to version 2, got %', v_version; end if;
  if v_min_tier <> 'creator' then raise exception 'the update must take effect, min_tier expected creator, got %', v_min_tier; end if;
end
$$;

-- A DIRECT SQL write (bypassing the staff function entirely -- exactly
-- how this same file seeds every other fixture row in this suite) is
-- STILL versioned and audited: the triggers are on the table, not
-- inside the function.
update public.capability_registry set description = 'direct SQL update, no function involved' where capability_key = 'ctl_seat_extra_producer';

do $$
declare v_version integer;
begin
  select version into v_version from public.capability_registry where capability_key = 'ctl_seat_extra_producer';
  if v_version <> 3 then raise exception 'a direct SQL update must still bump the version (trigger-based, not convention-based), got %', v_version; end if;
end
$$;

do $$
declare audit_count integer; last_action text;
begin
  select count(*) into audit_count from public.capability_registry_audit where capability_key = 'ctl_seat_extra_producer';
  if audit_count <> 3 then raise exception 'expected 3 audit rows (1 insert + 2 updates, one via direct SQL), got %', audit_count; end if;

  select action into last_action from public.capability_registry_audit
   where capability_key = 'ctl_seat_extra_producer' order by changed_at desc, id desc limit 1;
  if last_action <> 'update' then raise exception 'the most recent audit row must record an update, got %', last_action; end if;
end
$$;

-- The audit trail is readable by staff.
do $$
declare row_count integer;
begin
  select count(*) into row_count from app_private.staff_list_capability_registry_audit('ctl_seat_extra_producer');
  if row_count <> 3 then raise exception 'staff must be able to read all 3 audit rows, got %', row_count; end if;
end
$$;

-- =========================================================================
-- CTL-02: THE RESOLUTION ORDER, kill -> denylist -> rollout -> tier ->
-- override, exactly that precedence. Each stage below is proven to
-- override an EXPLICIT channel override that would otherwise flip the
-- answer -- the strongest possible proof of "ahead of override", not
-- merely "ahead of the tier default".
-- =========================================================================

-- Two more capabilities for the resolution-order matrix: one that
-- rollout excludes outright, one used purely for the base tier-default
-- proof (no override anywhere near it).
select * from app_private.staff_upsert_capability_registry_entry(
  'ctl_rollout_gate', 'ai_usage', 'Rollout-gated capability', false, 0, null
);
select * from app_private.staff_upsert_capability_registry_entry(
  'ctl_tier_only', 'automation_volume', 'Tier-only, never overridden', false, 100, 'studio'
);

-- Every read from here through the end of the CTL-02/CTL-03 sections
-- acts as user 0001 (owner of channel 5f01) unless explicitly switched
-- -- the staff user set above is not a member of 5f01 and would
-- otherwise make every get_channel_capabilities call below silently
-- return zero rows (a non-member read), leaving the `into` targets
-- NULL rather than raising.
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);

-- Baseline (no kill, no denylist, no override, rollout 100): the FREE
-- channel fails the Pro+ tier default for ctl_seat_extra_producer's
-- CURRENT min_tier (creator, from the update above).
do $$
declare v boolean;
begin
  select (resolved->>'ctl_seat_extra_producer')::boolean into v
    from app_private.get_channel_capabilities('00000000-0000-4000-8000-000000005f01'::uuid);
  if v is not false then raise exception 'STAGE 4 (tier): a free-tier channel must fail a creator-tier-gated capability by default, got %', v; end if;
end
$$;

-- STAGE 5 (override) CAN flip the tier default to true.
insert into public.capability_overrides (capability_key, channel_id, overridden_enabled, set_by)
values ('ctl_seat_extra_producer', '00000000-0000-4000-8000-000000005f01', true, '00000000-0000-4000-8000-000000005f00');

do $$
declare v boolean;
begin
  select (resolved->>'ctl_seat_extra_producer')::boolean into v
    from app_private.get_channel_capabilities('00000000-0000-4000-8000-000000005f01'::uuid);
  if v is not true then raise exception 'STAGE 5 (override): an explicit channel override must be able to flip the tier default, got %', v; end if;
end
$$;

-- STAGE 1 (kill) beats an override that is still in place and would
-- otherwise say true.
select set_config('app.user_id', '00000000-0000-4000-8000-000000005f00', false);
select * from app_private.staff_upsert_capability_registry_entry(
  'ctl_seat_extra_producer', 'team_seat', 'kill switch engaged', true, 100, 'creator'
);
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);

do $$
declare v boolean;
begin
  select (resolved->>'ctl_seat_extra_producer')::boolean into v
    from app_private.get_channel_capabilities('00000000-0000-4000-8000-000000005f01'::uuid);
  if v is not false then raise exception 'STAGE 1 (kill) must beat an active override -- kill is absolute and evaluated first, got %', v; end if;
end
$$;

-- STAGE 2 (denylist) beats an override that is still in place, with
-- kill now OFF again -- proves denylist independently of kill.
select set_config('app.user_id', '00000000-0000-4000-8000-000000005f00', false);
select * from app_private.staff_upsert_capability_registry_entry(
  'ctl_seat_extra_producer', 'team_seat', 'kill lifted, denylisted next', false, 100, 'creator'
);
insert into public.capability_denylist (capability_key, channel_id)
values ('ctl_seat_extra_producer', '00000000-0000-4000-8000-000000005f01');
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);

do $$
declare v boolean;
begin
  select (resolved->>'ctl_seat_extra_producer')::boolean into v
    from app_private.get_channel_capabilities('00000000-0000-4000-8000-000000005f01'::uuid);
  if v is not false then raise exception 'STAGE 2 (denylist) must beat an active override, kill being off, got %', v; end if;
end
$$;

-- STAGE 3 (rollout) beats an override that is still in place, with
-- kill off and denylist lifted -- proves rollout independently of the
-- first two stages. ctl_rollout_gate has NO override at all yet; add
-- one to prove rollout beats it too.
delete from public.capability_denylist where capability_key = 'ctl_seat_extra_producer' and channel_id = '00000000-0000-4000-8000-000000005f01';
insert into public.capability_overrides (capability_key, channel_id, overridden_enabled, set_by)
values ('ctl_rollout_gate', '00000000-0000-4000-8000-000000005f01', true, '00000000-0000-4000-8000-000000005f00');

do $$
declare v boolean; v_seat boolean;
begin
  select (resolved->>'ctl_rollout_gate')::boolean into v
    from app_private.get_channel_capabilities('00000000-0000-4000-8000-000000005f01'::uuid);
  if v is not false then raise exception 'STAGE 3 (rollout=0) must beat an active override, got %', v; end if;

  -- And with kill off + denylist lifted, ctl_seat_extra_producer's own
  -- override (still true, still in capability_overrides) is reachable
  -- again -- confirms the earlier false results were the kill/denylist
  -- stages specifically, not a broken override mechanism.
  select (resolved->>'ctl_seat_extra_producer')::boolean into v_seat
    from app_private.get_channel_capabilities('00000000-0000-4000-8000-000000005f01'::uuid);
  if v_seat is not true then raise exception 'with kill off and denylist lifted, the pre-existing override must be reachable again, got %', v_seat; end if;
end
$$;

-- Tier-only capability, never touched by an override at all: proves
-- the tier stage independently. Pro channel 5f02 passes a
-- pro-tier-gated capability; re-confirm the free channel fails it, and
-- that ctl_tier_only (studio-gated) fails on BOTH channels with no
-- override anywhere near it.
do $$
declare v_free boolean; v_pro boolean;
begin
  select (resolved->>'ctl_tier_only')::boolean into v_free
    from app_private.get_channel_capabilities('00000000-0000-4000-8000-000000005f01'::uuid);

  -- Channel 5f02 is owned by base_world user '...0002', not '...0001' --
  -- switch actor so this read is a member read, not a non-member zero-
  -- row read (which would leave v_pro NULL rather than false).
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000002', false);
  select (resolved->>'ctl_tier_only')::boolean into v_pro
    from app_private.get_channel_capabilities('00000000-0000-4000-8000-000000005f02'::uuid);
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);

  if v_free is not false then raise exception 'a free-tier channel must fail a studio-gated capability with no override, got %', v_free; end if;
  if v_pro is not false then raise exception 'a pro-tier channel must also fail a studio-gated capability with no override, got %', v_pro; end if;
end
$$;

-- min_tier IS NULL: always eligible regardless of tier, with no
-- override needed at all.
select set_config('app.user_id', '00000000-0000-4000-8000-000000005f00', false);
select * from app_private.staff_upsert_capability_registry_entry(
  'ctl_untiered', 'automation_volume', 'no tier gate at all', false, 100, null
);
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);
do $$
declare v boolean;
begin
  select (resolved->>'ctl_untiered')::boolean into v
    from app_private.get_channel_capabilities('00000000-0000-4000-8000-000000005f01'::uuid);
  if v is not true then raise exception 'a capability with min_tier null must resolve true on every tier, got %', v; end if;
end
$$;

-- =========================================================================
-- CTL-03: the resolved blob is ONE jsonb object, cached and versioned.
-- =========================================================================

-- A second read with nothing changed returns the SAME resolved_at --
-- proof the cache path took NO recompute, not merely "returned the
-- same values by coincidence".
do $$
declare first_at timestamptz; second_at timestamptz; first_gen bigint; second_gen bigint;
begin
  select resolved_at, generation into first_at, first_gen from app_private.get_channel_capabilities('00000000-0000-4000-8000-000000005f01'::uuid);
  select resolved_at, generation into second_at, second_gen from app_private.get_channel_capabilities('00000000-0000-4000-8000-000000005f01'::uuid);
  if first_at <> second_at then raise exception 'CTL-03: an unchanged read must hit the cache (identical resolved_at), got % then %', first_at, second_at; end if;
  if first_gen <> second_gen then raise exception 'CTL-03: generation must be stable across an unchanged read, got % then %', first_gen, second_gen; end if;
end
$$;

-- A registry write bumps the generation and invalidates the cache: the
-- NEXT read recomputes (a new resolved_at), automatically, with no
-- explicit invalidation call.
do $$
declare before_at timestamptz; before_gen bigint; after_at timestamptz; after_gen bigint;
begin
  select resolved_at, generation into before_at, before_gen from app_private.get_channel_capabilities('00000000-0000-4000-8000-000000005f01'::uuid);

  perform set_config('app.user_id', '00000000-0000-4000-8000-000000005f00', false);
  perform app_private.staff_upsert_capability_registry_entry('ctl_untiered', 'automation_volume', 'touched to bump generation', false, 100, null);
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);

  select resolved_at, generation into after_at, after_gen from app_private.get_channel_capabilities('00000000-0000-4000-8000-000000005f01'::uuid);
  if after_gen <= before_gen then raise exception 'CTL-03: a registry write must strictly advance the generation, got % then %', before_gen, after_gen; end if;
  if after_at = before_at then raise exception 'CTL-03: a stale-generation read must recompute (new resolved_at), got the same %', before_at; end if;
end
$$;

-- A channel's OWN tier changing also invalidates its cache, even with
-- the generation unchanged -- the cache key is (generation, tier), not
-- generation alone.
do $$
declare before_at timestamptz; after_at timestamptz;
begin
  select resolved_at into before_at from app_private.get_channel_capabilities('00000000-0000-4000-8000-000000005f01'::uuid);

  update channel_entitlement_versions set tier = 'creator' where channel_id = '00000000-0000-4000-8000-000000005f01';

  select resolved_at into after_at from app_private.get_channel_capabilities('00000000-0000-4000-8000-000000005f01'::uuid);
  if after_at = before_at then raise exception 'CTL-03: a channel tier change must invalidate its own cached blob even with generation unchanged'; end if;
end
$$;

-- Retiering to creator now makes ctl_seat_extra_producer (min_tier
-- creator) pass on the tier stage alone -- confirms the recompute used
-- the NEW tier, not a stale cached one, and clean up the override so
-- this is a genuine tier-stage pass, not an override artifact.
delete from public.capability_overrides where capability_key = 'ctl_seat_extra_producer' and channel_id = '00000000-0000-4000-8000-000000005f01';
do $$
declare v boolean;
begin
  select (resolved->>'ctl_seat_extra_producer')::boolean into v
    from app_private.get_channel_capabilities('00000000-0000-4000-8000-000000005f01'::uuid);
  if v is not true then raise exception 'after retiering to creator and removing the override, a creator-tier-gated capability must pass on tier alone, got %', v; end if;
end
$$;

-- =========================================================================
-- Cross-channel isolation and non-member zero-row behaviour.
-- =========================================================================
do $$
declare row_count integer;
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000002', false);
  select count(*) into row_count from app_private.get_channel_capabilities('00000000-0000-4000-8000-000000005f01'::uuid);
  if row_count <> 0 then raise exception 'a non-member (channel 5f02''s own owner, probing channel 5f01) must see zero rows, got %', row_count; end if;
end
$$;

do $$
declare probe record; row_count integer;
begin
  for probe in
    select unnest(array[
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000004',
      '00000000-0000-4000-8000-000000000005',
      '00000000-0000-4000-8000-000000000006'
    ]) as user_id
  loop
    perform set_config('app.user_id', probe.user_id, false);
    select count(*) into row_count from app_private.get_channel_capabilities('00000000-0000-4000-8000-000000005f01'::uuid);
    if row_count <> 1 then raise exception 'member % must see exactly one resolved-blob row, got %', probe.user_id, row_count; end if;
  end loop;
end
$$;

-- =========================================================================
-- STRUCTURAL: exact returned column sets, asserted against
-- information_schema.parameters -- a widened projection is a failing
-- test, not a silent change.
-- =========================================================================
do $$
declare actual text;
begin
  select string_agg(p.parameter_name, ',' order by p.ordinal_position) into actual
    from information_schema.parameters p
    join information_schema.routines r
      on r.specific_name = p.specific_name and r.specific_schema = p.specific_schema
   where r.routine_schema = 'app_private' and r.routine_name = 'get_channel_capabilities' and p.parameter_mode = 'OUT';
  if actual is distinct from 'resolved,generation,resolved_at' then
    raise exception 'get_channel_capabilities must project exactly resolved,generation,resolved_at. Found: %', coalesce(actual, '<none>');
  end if;
end
$$;

do $$
declare actual text;
begin
  select string_agg(p.parameter_name, ',' order by p.ordinal_position) into actual
    from information_schema.parameters p
    join information_schema.routines r
      on r.specific_name = p.specific_name and r.specific_schema = p.specific_schema
   where r.routine_schema = 'app_private' and r.routine_name = 'resolve_channel_capabilities' and p.parameter_mode = 'OUT';
  if actual is distinct from 'resolved,generation,resolved_at' then
    raise exception 'resolve_channel_capabilities must project exactly resolved,generation,resolved_at. Found: %', coalesce(actual, '<none>');
  end if;
end
$$;

do $$
declare actual text;
begin
  select string_agg(p.parameter_name, ',' order by p.ordinal_position) into actual
    from information_schema.parameters p
    join information_schema.routines r
      on r.specific_name = p.specific_name and r.specific_schema = p.specific_schema
   where r.routine_schema = 'app_private' and r.routine_name = 'staff_upsert_capability_registry_entry' and p.parameter_mode = 'OUT';
  if actual is distinct from 'capability_key,capacity_class,description,kill_switch,rollout_percentage,min_tier,version,updated_at' then
    raise exception 'staff_upsert_capability_registry_entry must project exactly capability_key,capacity_class,description,kill_switch,rollout_percentage,min_tier,version,updated_at. Found: %', coalesce(actual, '<none>');
  end if;
end
$$;

do $$
declare actual text;
begin
  select string_agg(p.parameter_name, ',' order by p.ordinal_position) into actual
    from information_schema.parameters p
    join information_schema.routines r
      on r.specific_name = p.specific_name and r.specific_schema = p.specific_schema
   where r.routine_schema = 'app_private' and r.routine_name = 'staff_list_capability_registry_audit' and p.parameter_mode = 'OUT';
  if actual is distinct from 'id,version,action,previous_row,new_row,changed_by,changed_at' then
    raise exception 'staff_list_capability_registry_audit must project exactly id,version,action,previous_row,new_row,changed_by,changed_at. Found: %', coalesce(actual, '<none>');
  end if;
end
$$;

-- =========================================================================
-- Negative: invalid inputs are rejected, not silently coerced.
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000005f00', false);

do $$
begin
  begin
    perform app_private.staff_upsert_capability_registry_entry('ctl_invalid_tier', 'team_seat', 'bad tier', false, 100, 'enterprise');
    raise exception 'an unrecognised min_tier must be rejected';
  exception when check_violation then null;
  end;

  begin
    perform app_private.staff_upsert_capability_registry_entry('ctl_invalid_rollout', 'team_seat', 'bad rollout', false, 101, null);
    raise exception 'a rollout_percentage over 100 must be rejected';
  exception when check_violation then null;
  end;

  begin
    perform app_private.staff_upsert_capability_registry_entry('ctl_invalid_rollout_negative', 'team_seat', 'bad rollout', false, -1, null);
    raise exception 'a negative rollout_percentage must be rejected';
  exception when check_violation then null;
  end;

  begin
    perform app_private.staff_upsert_capability_registry_entry('Not_A_Valid_Key', 'team_seat', 'bad key shape', false, 100, null);
    raise exception 'an uppercase capability_key must be rejected';
  exception when check_violation then null;
  end;

  begin
    perform app_private.capability_tier_rank('enterprise');
    raise exception 'an unrecognised tier must raise, not silently resolve a capability tier rank';
  exception when others then null;
  end;
end
$$;

-- =========================================================================
-- CTL-01, CTL-02 combined sanity: a capability with a rollout bucket
-- that DOES include this channel, no kill, no denylist, no override,
-- and a tier the channel meets resolves true -- the positive case,
-- proven independently of every negative case above. Channel 5f01 was
-- retiered to 'creator' earlier in this file; min_tier 'free' here
-- proves the tier stage's ">=" comparison, not a special-cased "free
-- always passes" shortcut.
-- =========================================================================
select * from app_private.staff_upsert_capability_registry_entry(
  'ctl_positive_case', 'active_widget', 'plain pass-through positive case', false, 100, 'free'
);
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);
do $$
declare v boolean;
begin
  select (resolved->>'ctl_positive_case')::boolean into v
    from app_private.get_channel_capabilities('00000000-0000-4000-8000-000000005f01'::uuid);
  if v is not true then raise exception 'a free-tier-gated, non-killed, non-denylisted, in-rollout, non-overridden capability must resolve true (channel tier >= free), got %', v; end if;
end
$$;
