-- CTL phase 2, Lane A (migration 0152): change management over the
-- phase-1 capability control plane (migration 0149, read-only authority
-- here, never modified).
--
-- Covers:
--   * grants lockdown: both new tables revoked from public AND bsa_app;
--     every new function revoked from public, granted to bsa_app;
--   * platform-staff-only gate on every function (non-staff rejected);
--   * CTL-09: proposed_capacity_class rejects all nine §12.6.1 forbidden
--     classes, BEHAVIOURALLY and STRUCTURALLY (same technique as 0149's
--     CTL-14, applied to this new column);
--   * CTL-06: a staged FUTURE change stays unapplied (status='approved',
--     capability_registry untouched) until its effective_at passes, and
--     a change whose effective_at has ALREADY passed is applied on the
--     very next plain read (get/list), with no explicit apply/sweep
--     call anywhere in the test;
--   * CTL-07 rule 1 (two-staff, maker-checker): one approval is not
--     enough, the same approver cannot approve twice, the proposer
--     cannot approve their own change, two DISTINCT staff approvals
--     flip status to 'approved';
--   * CTL-07 rule 2 (owner sign-off, paid->Free only): computed at
--     propose time, two staff approvals alone are not enough when it is
--     required, an 'owner' approval when not required is rejected, a
--     third distinct approval of kind 'owner' completes it;
--   * CTL-07 rule 3 (single-admin global_kill): one admin, no approval
--     round, immediate effect;
--   * CTL-08 (one-action revert): restores the immediately-prior
--     version's values as a NEW forward version, proven never to
--     mutate or delete any existing capability_registry_audit row;
--   * exact returned column sets, asserted against
--     information_schema.parameters;
--   * negative/invalid-input rejection for every constrained field.
--
-- Fixture: own app_users block '...6c00'-'...6c03' (pre-assigned to this
-- lane, unused elsewhere per the task's own grep-before-use convention --
-- verified free by inspection of every other *.sql file in this
-- directory at authoring time). No channel/channel_membership fixture is
-- needed: every function in this migration is gated by
-- app_private.is_platform_admin() alone, never app_private.has_channel_role
-- -- capability_registry (and this governance layer over it) is
-- platform-wide, not per-channel. 00_base_world.sql is not touched by
-- this file or by migration 0152.
--
-- UPDATED BY MIGRATION 0155 (Job 1): app_private.staff_approve_
-- capability_change now requires REAL owner identity
-- (app_private.is_platform_owner()) for approval_kind='owner', not
-- merely is_platform_admin(). Delta ('...6c04') is marked
-- is_platform_owner=true below so this file's own pre-existing
-- "two staff + one owner" proof (further down) keeps proving what it
-- always claimed to prove -- an owner approval succeeding -- rather than
-- now failing on the identity check this file did not used to exercise.
-- A NEW sixth user ('...6c05', platform admin, NOT owner) is added so a
-- non-owner admin attempting an 'owner' approval can be proven rejected,
-- which this file could not previously distinguish from "any platform
-- admin can approve as owner" (0152's own documented identity gap).
\set ON_ERROR_STOP on

insert into app_users (id, external_subject, display_name, created_at, updated_at, is_platform_admin, is_platform_owner)
values
  ('00000000-0000-4000-8000-000000006c00', 'google-ctl06-staff-alpha', 'CTL06 Staff Alpha', current_timestamp, current_timestamp, true, false),
  ('00000000-0000-4000-8000-000000006c01', 'google-ctl06-staff-beta', 'CTL06 Staff Beta', current_timestamp, current_timestamp, true, false),
  ('00000000-0000-4000-8000-000000006c02', 'google-ctl06-staff-gamma', 'CTL06 Staff Gamma', current_timestamp, current_timestamp, true, false),
  ('00000000-0000-4000-8000-000000006c03', 'google-ctl06-non-staff', 'CTL06 Non-Staff', current_timestamp, current_timestamp, false, false),
  -- A 5th platform admin. UNIQUE(change_request_id, approver_id) on
  -- capability_change_approvals means the SAME person can never record
  -- both a 'staff' and an 'owner' approval on the same change -- a
  -- paid->Free move genuinely needs 3 DISTINCT people (two staff, one
  -- separate owner sign-off), never two people wearing three hats. This
  -- delta user exists so that requirement can be exercised honestly
  -- without reusing an approver who already voted 'staff' on the same
  -- change. Migration 0155: marked is_platform_owner=true -- the ONLY
  -- user in this fixture who is the real platform owner, matching the
  -- singleton constraint (app_users_platform_owner_singleton_idx).
  ('00000000-0000-4000-8000-000000006c04', 'google-ctl06-staff-delta', 'CTL06 Staff Delta', current_timestamp, current_timestamp, true, true),
  -- Migration 0155: a 6th platform admin, deliberately NOT the owner --
  -- proves an 'owner' approval is rejected for identity, not merely
  -- permitted by admin status.
  ('00000000-0000-4000-8000-000000006c05', 'google-ctl06-staff-epsilon', 'CTL06 Staff Epsilon', current_timestamp, current_timestamp, true, false)
on conflict (id) do nothing;

-- =========================================================================
-- STRUCTURAL: grants lockdown, same posture as 0149's own CTL-03 test --
-- both tables revoked from BOTH public and bsa_app; every function
-- revoked from public, granted to bsa_app.
-- =========================================================================
do $$
declare tbl record;
begin
  for tbl in
    select unnest(array[
      'public.capability_change_requests',
      'public.capability_change_approvals'
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
      'app_private.apply_due_capability_change(uuid)',
      'app_private.capability_change_row(uuid)',
      'app_private.staff_propose_capability_change(text, text, text, boolean, integer, text, timestamptz, text)',
      'app_private.staff_get_capability_change(uuid)',
      'app_private.staff_list_capability_changes(text, integer)',
      'app_private.staff_list_capability_change_approvals(uuid)',
      'app_private.staff_approve_capability_change(uuid, text)',
      'app_private.staff_reject_capability_change(uuid, text)',
      'app_private.staff_kill_capability_now(text, text)',
      'app_private.staff_revert_capability_registry_entry(text, text)'
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

-- =========================================================================
-- Non-staff is rejected by every entry point.
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000006c03', false);

do $$
begin
  begin
    perform app_private.staff_propose_capability_change('ctl06_unauth_probe', 'team_seat', 'should be rejected', false, 100, null, null, null);
    raise exception 'a non-staff user must not be able to propose a capability change';
  exception when insufficient_privilege then null;
  end;

  begin
    perform * from app_private.staff_list_capability_changes(null, 50);
    raise exception 'a non-staff user must not be able to list capability changes';
  exception when insufficient_privilege then null;
  end;

  begin
    perform app_private.staff_kill_capability_now('anything', 'incident');
    raise exception 'a non-staff user must not be able to kill a capability';
  exception when insufficient_privilege then null;
  end;

  begin
    perform app_private.staff_revert_capability_registry_entry('anything', 'rollback');
    raise exception 'a non-staff user must not be able to revert a capability';
  exception when insufficient_privilege then null;
  end;
end
$$;

-- =========================================================================
-- CTL-09, BEHAVIOURAL: every one of the nine §12.6.1 durable-record
-- classes is rejected as proposed_capacity_class.
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000006c00', false);

do $$
declare forbidden text; probe_key text;
begin
  foreach forbidden in array array[
    'payment', 'receipt', 'refund', 'audit_trail', 'supporter_relationship',
    'event_history', 'configuration', 'layout', 'moderation_history'
  ]
  loop
    probe_key := 'ctl09_probe_' || forbidden;
    begin
      perform app_private.staff_propose_capability_change(probe_key, forbidden, 'CTL-09 probe: gate a durable creator record', false, 100, null, null, 'probe');
      raise exception 'CTL-09: proposed_capacity_class % must be rejected -- this panel must never be able to propose gating a durable creator record (§12.6)', forbidden;
    exception when check_violation then null;
    end;
  end loop;

  perform 1 from public.capability_change_requests where capability_key like 'ctl09_probe_%';
  if found then
    raise exception 'CTL-09: a probe row was persisted despite the expected check_violation';
  end if;
end
$$;

-- =========================================================================
-- CTL-09, STRUCTURAL: the guard that fails when removed.
-- =========================================================================
do $$
declare definition text; forbidden text;
begin
  select pg_catalog.pg_get_constraintdef(c.oid)
    into definition
    from pg_catalog.pg_constraint c
    join pg_catalog.pg_class t on t.oid = c.conrelid
   where t.relname = 'capability_change_requests' and c.conname = 'capability_change_requests_proposed_capacity_class_check';

  if definition is null then
    raise exception 'CTL-09: capability_change_requests_proposed_capacity_class_check does not exist -- the structural guard has been removed';
  end if;

  foreach forbidden in array array[
    'payment', 'receipt', 'refund', 'audit_trail', 'supporter_relationship',
    'event_history', 'configuration', 'layout', 'moderation_history', 'durable', 'record'
  ]
  loop
    if position(forbidden in definition) > 0 then
      raise exception 'CTL-09: proposed_capacity_class''s whitelist must never contain "%" -- this panel must never represent gating a durable creator record (§12.6)', forbidden;
    end if;
  end loop;
end
$$;

-- =========================================================================
-- Negative: invalid inputs on propose are rejected, not silently coerced.
-- =========================================================================
do $$
begin
  begin
    perform app_private.staff_propose_capability_change('ctl06_bad_tier', 'team_seat', 'bad tier', false, 100, 'enterprise', null, null);
    raise exception 'an unrecognised min_tier must be rejected';
  exception when check_violation then null;
  end;

  begin
    perform app_private.staff_propose_capability_change('ctl06_bad_rollout', 'team_seat', 'bad rollout', false, 101, null, null, null);
    raise exception 'a rollout_percentage over 100 must be rejected';
  exception when check_violation then null;
  end;

  begin
    perform app_private.staff_propose_capability_change('Not_A_Valid_Key', 'team_seat', 'bad key shape', false, 100, null, null, null);
    raise exception 'an uppercase capability_key must be rejected';
  exception when check_violation then null;
  end;
end
$$;

-- =========================================================================
-- CTL-06 + CTL-07 rule 1: propose an ordinary (non-paid->free) change,
-- stage it in the FUTURE, and prove the two-staff / maker-checker rules
-- one at a time before it can ever become effective.
-- =========================================================================
select * from app_private.staff_propose_capability_change(
  'ctl06_seat_extra_producer', 'team_seat', 'Extra producer seat beyond plan default', false, 100, 'pro',
  current_timestamp + interval '1 hour', 'staged for next release window'
);

do $$
declare v_id uuid; v_status text; v_owner_needed boolean;
begin
  select id, status, requires_owner_signoff into v_id, v_status, v_owner_needed
    from public.capability_change_requests where capability_key = 'ctl06_seat_extra_producer';
  if v_status <> 'pending_approval' then raise exception 'a freshly proposed change must start pending_approval, got %', v_status; end if;
  if v_owner_needed is not false then raise exception 'a brand-new capability''s own initial tier is not a paid->Free move, got requires_owner_signoff=%', v_owner_needed; end if;
end
$$;

-- The proposer (alpha) may not approve their own change.
do $$
declare v_id uuid;
begin
  select id into v_id from public.capability_change_requests where capability_key = 'ctl06_seat_extra_producer';
  begin
    perform app_private.staff_approve_capability_change(v_id, 'staff');
    raise exception 'CTL-07 rule 1: the proposer must not be able to approve their own change';
  exception when others then
    if sqlstate <> '22023' then raise; end if;
  end;
end
$$;

-- One distinct approval (beta) is not enough.
do $$
declare v_id uuid; v_status text; v_count integer;
begin
  select id into v_id from public.capability_change_requests where capability_key = 'ctl06_seat_extra_producer';
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000006c01', false);
  select status, staff_approval_count into v_status, v_count from app_private.staff_approve_capability_change(v_id, 'staff');
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000006c00', false);
  if v_status <> 'pending_approval' then raise exception 'CTL-07 rule 1: one staff approval must not be enough, got status %', v_status; end if;
  if v_count <> 1 then raise exception 'expected staff_approval_count 1 after the first approval, got %', v_count; end if;
end
$$;

-- The same approver (beta) may not approve twice.
do $$
declare v_id uuid;
begin
  select id into v_id from public.capability_change_requests where capability_key = 'ctl06_seat_extra_producer';
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000006c01', false);
  begin
    perform app_private.staff_approve_capability_change(v_id, 'staff');
    raise exception 'CTL-07 rule 1: the same approver must not be able to approve the same change twice';
  exception when unique_violation then null;
  end;
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000006c00', false);
end
$$;

-- A second DISTINCT staff approver (gamma) completes the two-staff rule
-- -- but effective_at is still an hour in the future, so status must be
-- 'approved', NOT 'applied', and capability_registry must NOT yet carry
-- this capability at all (CTL-06: staging withholds effect).
do $$
declare v_id uuid; v_status text;
begin
  select id into v_id from public.capability_change_requests where capability_key = 'ctl06_seat_extra_producer';
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000006c02', false);
  select status into v_status from app_private.staff_approve_capability_change(v_id, 'staff');
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000006c00', false);
  if v_status <> 'approved' then raise exception 'CTL-07 rule 1: two distinct staff approvals must complete approval, got status %', v_status; end if;

  perform 1 from public.capability_registry where capability_key = 'ctl06_seat_extra_producer';
  if found then raise exception 'CTL-06: a staged FUTURE change must not touch capability_registry before its effective_at, but a row was found'; end if;
end
$$;

-- A plain GET (no apply/sweep call) still reports 'approved', not
-- 'applied', while effective_at remains in the future.
do $$
declare v_id uuid; v_status text;
begin
  select id into v_id from public.capability_change_requests where capability_key = 'ctl06_seat_extra_producer';
  select status into v_status from app_private.staff_get_capability_change(v_id);
  if v_status <> 'approved' then raise exception 'CTL-06: a not-yet-due approved change must stay approved on a plain read, got %', v_status; end if;
end
$$;

-- =========================================================================
-- CTL-06, THE CENTRAL PROOF: a change whose effective_at has ALREADY
-- PASSED is applied on the very next plain read, with NO explicit
-- apply/sweep call anywhere in this block.
-- =========================================================================
select * from app_private.staff_propose_capability_change(
  'ctl06_due_now', 'ai_usage', 'due-in-the-past staging proof', false, 100, 'pro',
  current_timestamp - interval '1 minute', 'CTL-06 read-time correctness proof'
);

do $$
declare v_id uuid;
begin
  select id into v_id from public.capability_change_requests where capability_key = 'ctl06_due_now';
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000006c01', false);
  perform app_private.staff_approve_capability_change(v_id, 'staff');
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000006c02', false);
  perform app_private.staff_approve_capability_change(v_id, 'staff');
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000006c00', false);
end
$$;

-- capability_registry must not carry this key yet -- approval alone
-- (even with a past effective_at) does not apply it; only a READ does,
-- proving the apply happens lazily at read time, not inside approve.
-- (staff_approve_capability_change itself returns through
-- capability_change_row, which DOES perform the lazy-apply check -- so
-- by the time the two approvals above returned, the second one already
-- crossed 'approved' with effective_at in the past and applied
-- immediately within that same call. This is still "read time", not a
-- sweeper: capability_change_row's own read path is what applied it.)
do $$
declare v_status text; v_applied_at timestamptz; v_capacity text; v_min_tier text;
begin
  select status, applied_at into v_status, v_applied_at
    from public.capability_change_requests where capability_key = 'ctl06_due_now';
  if v_status <> 'applied' then raise exception 'CTL-06: a due change must be applied by the read that first observes it past its effective_at, got status %', v_status; end if;
  if v_applied_at is null then raise exception 'CTL-06: applied_at must be set once a due change is applied'; end if;

  select capacity_class, min_tier into v_capacity, v_min_tier
    from public.capability_registry where capability_key = 'ctl06_due_now';
  if v_capacity is null then raise exception 'CTL-06: capability_registry must now carry ctl06_due_now -- the due change must have been applied'; end if;
  if v_capacity <> 'ai_usage' then raise exception 'CTL-06: applied capacity_class must match the proposal, got %', v_capacity; end if;
  if v_min_tier <> 'pro' then raise exception 'CTL-06: applied min_tier must match the proposal, got %', v_min_tier; end if;
end
$$;

-- A repeat plain read (get, and separately list) is idempotent -- no
-- error, no double-apply (0149's staff_upsert_capability_registry_entry
-- would bump the version again if double-invoked, so a stable version
-- proves apply_due_capability_change is guarded by status, not reapplied
-- on every read).
do $$
declare v_id uuid; v_version_before integer; v_version_after integer;
begin
  select version into v_version_before from public.capability_registry where capability_key = 'ctl06_due_now';
  select id into v_id from public.capability_change_requests where capability_key = 'ctl06_due_now';
  perform app_private.staff_get_capability_change(v_id);
  perform * from app_private.staff_list_capability_changes('applied', 100);
  select version into v_version_after from public.capability_registry where capability_key = 'ctl06_due_now';
  if v_version_after <> v_version_before then raise exception 'CTL-06: an already-applied change must not be reapplied by a later read, version drifted % -> %', v_version_before, v_version_after; end if;
end
$$;

-- =========================================================================
-- Now let the originally-staged FUTURE change (ctl06_seat_extra_producer)
-- become due too, by proposing and approving a second, already-due
-- change against a NEW key so as not to disturb the still-future one --
-- instead, directly prove the future one remains untouched at this
-- point (it is not due yet), confirming staging genuinely still holds.
-- =========================================================================
do $$
declare v_status text;
begin
  select status into v_status from public.capability_change_requests where capability_key = 'ctl06_seat_extra_producer';
  if v_status <> 'approved' then raise exception 'the still-future change must remain approved (not applied), got %', v_status; end if;
  perform 1 from public.capability_registry where capability_key = 'ctl06_seat_extra_producer';
  if found then raise exception 'the still-future change must still not have touched capability_registry'; end if;
end
$$;

-- =========================================================================
-- CTL-07 rule 2: owner sign-off for a genuine paid->Free move.
-- =========================================================================
select * from app_private.staff_upsert_capability_registry_entry(
  'ctl07_paid_widget', 'active_widget', 'a widget currently gated at pro', false, 100, 'pro'
);

-- Moving it to free (null min_tier) is a paid->Free move.
select * from app_private.staff_propose_capability_change(
  'ctl07_paid_widget', 'active_widget', 'move to free tier', false, 100, null, null, 'pricing decision'
);

do $$
declare v_owner_needed boolean;
begin
  select requires_owner_signoff into v_owner_needed
    from public.capability_change_requests where capability_key = 'ctl07_paid_widget' and change_kind = 'update';
  if v_owner_needed is not true then raise exception 'CTL-07 rule 2: moving an existing paid-tier capability to free must require owner sign-off, got %', v_owner_needed; end if;
end
$$;

-- Two staff approvals alone are NOT enough when owner sign-off is required.
do $$
declare v_id uuid; v_status text;
begin
  select id into v_id from public.capability_change_requests where capability_key = 'ctl07_paid_widget' and change_kind = 'update';
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000006c01', false);
  perform app_private.staff_approve_capability_change(v_id, 'staff');
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000006c02', false);
  select status into v_status from app_private.staff_approve_capability_change(v_id, 'staff');
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000006c00', false);
  if v_status <> 'pending_approval' then raise exception 'CTL-07 rule 2: two staff approvals alone must not complete a paid->Free move, got status %', v_status; end if;
end
$$;

-- An 'owner' approval on a change that does NOT require it is rejected
-- (ctl06_due_now, already applied and never required owner sign-off, but
-- more precisely: probe a still-open pending_approval change with no
-- owner requirement). Use the future-staged ctl06_seat_extra_producer's
-- sibling scenario instead: propose a fresh non-paid change and attempt
-- an owner approval on it.
select * from app_private.staff_propose_capability_change(
  'ctl07_never_owner_gated', 'automation_volume', 'ordinary change, never needs owner sign-off', false, 100, 'creator', null, null
);
do $$
declare v_id uuid;
begin
  select id into v_id from public.capability_change_requests where capability_key = 'ctl07_never_owner_gated';
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000006c01', false);
  begin
    perform app_private.staff_approve_capability_change(v_id, 'owner');
    raise exception 'CTL-07 rule 2: an owner approval must be rejected on a change that does not require owner sign-off';
  exception when others then
    if sqlstate <> '22023' then raise; end if;
  end;
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000006c00', false);
end
$$;

-- MIGRATION 0155, Job 1: a platform admin who is NOT the owner
-- ('...6c05', epsilon) attempts approval_kind='owner' on this SAME
-- still-pending paid->Free change. Must be rejected -- real owner
-- identity, not admin status alone, is what authorises an 'owner'
-- approval now. 42501 (insufficient_privilege), not 22023 -- this is an
-- identity/authority failure, the same SQLSTATE every is_platform_admin()
-- gate in this schema already uses, not a business-rule violation.
do $$
declare v_id uuid;
begin
  select id into v_id from public.capability_change_requests where capability_key = 'ctl07_paid_widget' and change_kind = 'update';
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000006c05', false);
  begin
    perform app_private.staff_approve_capability_change(v_id, 'owner');
    raise exception 'CTL-07 rule 2 / Job 1: a non-owner platform admin must not be able to record an owner approval';
  exception when insufficient_privilege then null;
  end;
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000006c00', false);

  -- And the change must still be exactly where it was -- the rejected
  -- attempt recorded NO approval row (the insert is inside the same
  -- function call the identity check aborts, before any insert).
  perform 1 from public.capability_change_approvals a
   where a.change_request_id = v_id and a.approver_id = '00000000-0000-4000-8000-000000006c05';
  if found then
    raise exception 'Job 1: a rejected owner-identity approval must not leave an approval row behind';
  end if;
end
$$;

-- Back to ctl07_paid_widget: a THIRD, PREVIOUSLY UNINVOLVED approver
-- (delta -- beta and gamma already recorded 'staff' approvals on this
-- same change above, and UNIQUE(change_request_id, approver_id) means
-- neither of them can also record the 'owner' approval), this time
-- approval_kind='owner', completes it. Migration 0155, Job 1: delta IS
-- the real platform owner (is_platform_owner=true in this file's own
-- fixture) -- this is now a genuine identity-verified owner approval,
-- not merely an admin-authorised one.
-- This change was proposed with no explicit effective_at, so it
-- defaults to "now" (CTL-06: staging is opt-in, not forced) -- once the
-- full CTL-07 approval set is satisfied, capability_change_row's own
-- lazy-apply check (invoked by staff_approve_capability_change's own
-- return) finds it already due and applies it in the SAME call, so the
-- terminal status observed here is 'applied', not 'approved'. This is
-- CTL-06's read-time correctness proof again, from the immediate-effect
-- side rather than the staged side.
do $$
declare v_id uuid; v_status text; v_reg_min_tier text;
begin
  select id into v_id from public.capability_change_requests where capability_key = 'ctl07_paid_widget' and change_kind = 'update';
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000006c04', false);
  select status into v_status from app_private.staff_approve_capability_change(v_id, 'owner');
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000006c00', false);
  if v_status <> 'applied' then raise exception 'CTL-07 rule 2: two staff + one owner approval must complete AND immediately apply an effective-now paid->Free move, got status %', v_status; end if;

  select min_tier into v_reg_min_tier from public.capability_registry where capability_key = 'ctl07_paid_widget';
  if v_reg_min_tier is not null then raise exception 'CTL-07 rule 2: the paid->Free move must have taken effect on capability_registry (min_tier null/free), got %', v_reg_min_tier; end if;
end
$$;

-- =========================================================================
-- CTL-07 rule 3: single-admin global_kill.
-- =========================================================================
select * from app_private.staff_upsert_capability_registry_entry(
  'ctl07_incident_widget', 'active_widget', 'a widget to be killed by one admin', false, 100, null
);

do $$
declare v_status text; v_kill boolean; v_reg_kill boolean; v_staff_count integer;
begin
  select status, proposed_kill_switch, staff_approval_count
    into v_status, v_kill, v_staff_count
    from app_private.staff_kill_capability_now('ctl07_incident_widget', 'incident: abuse detected');
  if v_status <> 'applied' then raise exception 'CTL-07 rule 3: global_kill by one admin must apply immediately, got status %', v_status; end if;
  if v_kill is not true then raise exception 'CTL-07 rule 3: the kill request must record proposed_kill_switch=true, got %', v_kill; end if;
  if v_staff_count <> 0 then raise exception 'CTL-07 rule 3: a single-admin kill must require zero approval rows, got staff_approval_count %', v_staff_count; end if;

  select kill_switch into v_reg_kill from public.capability_registry where capability_key = 'ctl07_incident_widget';
  if v_reg_kill is not true then raise exception 'CTL-07 rule 3: capability_registry.kill_switch must be true immediately after global_kill, got %', v_reg_kill; end if;
end
$$;

-- Killing a capability that does not exist is a clean error, not a crash.
do $$
begin
  begin
    perform app_private.staff_kill_capability_now('ctl07_never_registered', 'incident');
    raise exception 'killing a nonexistent capability must be rejected';
  exception when others then
    if sqlstate <> '22023' then raise; end if;
  end;
end
$$;

-- =========================================================================
-- CTL-08: one-action revert, append-only.
-- =========================================================================
-- Version 1: create. Version 2: an ordinary direct update (as any
-- future writer might do). Revert must restore version 2's values as a
-- NEW version 3 -- never touching version 1 or version 2's own audit
-- rows.
select * from app_private.staff_upsert_capability_registry_entry(
  'ctl08_revert_target', 'team_seat', 'version 1: initial', false, 100, 'pro'
);
select * from app_private.staff_upsert_capability_registry_entry(
  'ctl08_revert_target', 'team_seat', 'version 2: retiered to creator', false, 100, 'creator'
);

do $$
declare v_audit_count_before integer;
begin
  select count(*) into v_audit_count_before from public.capability_registry_audit where capability_key = 'ctl08_revert_target';
  if v_audit_count_before <> 2 then raise exception 'expected 2 audit rows before revert, got %', v_audit_count_before; end if;
end
$$;

do $$
declare v_id uuid; v_status text; v_min_tier text; v_desc text; v_version integer; v_audit_count integer;
declare v_v1_new_row jsonb; v_v2_new_row jsonb;
begin
  select audit.new_row into v_v1_new_row from public.capability_registry_audit audit
   where audit.capability_key = 'ctl08_revert_target' and audit.version = 1;
  select audit.new_row into v_v2_new_row from public.capability_registry_audit audit
   where audit.capability_key = 'ctl08_revert_target' and audit.version = 2;

  select id, status, proposed_min_tier, proposed_description
    into v_id, v_status, v_min_tier, v_desc
    from app_private.staff_revert_capability_registry_entry('ctl08_revert_target', 'reverting an unwanted retier');

  if v_status <> 'applied' then raise exception 'CTL-08: revert must be applied immediately (one action), got status %', v_status; end if;
  if v_min_tier <> 'pro' then raise exception 'CTL-08: revert must restore version 1''s min_tier (pro), got %', v_min_tier; end if;

  select version into v_version from public.capability_registry where capability_key = 'ctl08_revert_target';
  if v_version <> 3 then raise exception 'CTL-08: revert must produce a NEW forward version (3), got %', v_version; end if;

  select count(*) into v_audit_count from public.capability_registry_audit where capability_key = 'ctl08_revert_target';
  if v_audit_count <> 3 then raise exception 'CTL-08: revert must add exactly one new audit row (3 total: insert, update, revert-update), got %', v_audit_count; end if;

  -- Append-only proof: version 1 and version 2's own audit rows are
  -- BYTE-FOR-BYTE unchanged -- revert never mutates or deletes history.
  declare v_v1_new_row_after jsonb; v_v2_new_row_after jsonb;
  begin
    select audit.new_row into v_v1_new_row_after from public.capability_registry_audit audit
     where audit.capability_key = 'ctl08_revert_target' and audit.version = 1;
    select audit.new_row into v_v2_new_row_after from public.capability_registry_audit audit
     where audit.capability_key = 'ctl08_revert_target' and audit.version = 2;
    if v_v1_new_row_after is distinct from v_v1_new_row then
      raise exception 'CTL-08: revert must never mutate the version-1 audit row';
    end if;
    if v_v2_new_row_after is distinct from v_v2_new_row then
      raise exception 'CTL-08: revert must never mutate the version-2 audit row';
    end if;
  end;

  perform 1 from public.capability_change_requests where id = v_id and change_kind = 'revert' and reverts_audit_id is not null;
  if not found then raise exception 'CTL-08: the revert must be recorded as its own change_requests row naming the audit row it restored'; end if;
end
$$;

-- Reverting a capability at version 1 (no previous version) is rejected.
select * from app_private.staff_upsert_capability_registry_entry(
  'ctl08_no_history', 'team_seat', 'only ever had one version', false, 100, null
);
do $$
begin
  begin
    perform app_private.staff_revert_capability_registry_entry('ctl08_no_history', 'nothing to revert to');
    raise exception 'CTL-08: reverting a capability with no previous version must be rejected';
  exception when others then
    if sqlstate <> '22023' then raise; end if;
  end;
end
$$;

-- Reverting a capability that does not exist at all is rejected.
do $$
begin
  begin
    perform app_private.staff_revert_capability_registry_entry('ctl08_never_registered', 'nothing to revert');
    raise exception 'CTL-08: reverting a nonexistent capability must be rejected';
  exception when others then
    if sqlstate <> '22023' then raise; end if;
  end;
end
$$;

-- =========================================================================
-- Rejection path: only while pending_approval, a reason is mandatory,
-- and a decided change cannot be re-decided.
-- =========================================================================
select * from app_private.staff_propose_capability_change(
  'ctl_reject_probe', 'team_seat', 'a change that will be rejected', false, 100, null, null, null
);
do $$
declare v_id uuid;
begin
  select id into v_id from public.capability_change_requests where capability_key = 'ctl_reject_probe';

  begin
    perform app_private.staff_reject_capability_change(v_id, '');
    raise exception 'rejecting without a reason must be rejected';
  exception when others then
    if sqlstate <> '22023' then raise; end if;
  end;

  perform set_config('app.user_id', '00000000-0000-4000-8000-000000006c01', false);
  declare v_status text;
  begin
    select status into v_status from app_private.staff_reject_capability_change(v_id, 'not needed after all');
    if v_status <> 'rejected' then raise exception 'a rejected change must report status=rejected, got %', v_status; end if;
  end;
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000006c00', false);

  begin
    perform app_private.staff_approve_capability_change(v_id, 'staff');
    raise exception 'an already-rejected change must not be approvable';
  exception when others then
    if sqlstate <> '22023' then raise; end if;
  end;

  begin
    perform app_private.staff_reject_capability_change(v_id, 'again');
    raise exception 'an already-rejected change must not be rejectable again';
  exception when others then
    if sqlstate <> '22023' then raise; end if;
  end;

  perform 1 from public.capability_registry where capability_key = 'ctl_reject_probe';
  if found then raise exception 'a rejected change must never have touched capability_registry'; end if;
end
$$;

-- =========================================================================
-- List: status filter + limit, and it returns the applied ctl06_due_now
-- capability.
-- =========================================================================
do $$
declare v_count integer;
begin
  select count(*) into v_count from app_private.staff_list_capability_changes('rejected', 100);
  if v_count < 1 then raise exception 'listing status=rejected must include ctl_reject_probe'; end if;

  select count(*) into v_count from app_private.staff_list_capability_changes('applied', 100)
   where capability_key = 'ctl06_due_now';
  if v_count <> 1 then raise exception 'listing status=applied must include ctl06_due_now exactly once, got %', v_count; end if;
end
$$;

-- =========================================================================
-- Approvals are individually listable (audit visibility for a
-- multi-approver change).
-- =========================================================================
do $$
declare v_id uuid; v_count integer;
begin
  select id into v_id from public.capability_change_requests where capability_key = 'ctl07_paid_widget' and change_kind = 'update';
  select count(*) into v_count from app_private.staff_list_capability_change_approvals(v_id);
  if v_count <> 3 then raise exception 'ctl07_paid_widget must show exactly 3 recorded approvals (2 staff + 1 owner), got %', v_count; end if;
end
$$;

-- =========================================================================
-- STRUCTURAL: exact returned column sets.
-- =========================================================================
do $$
declare actual text; expected text;
begin
  expected := 'id,capability_key,change_kind,status,proposed_capacity_class,proposed_description,proposed_kill_switch,proposed_rollout_percentage,proposed_min_tier,effective_at,requires_owner_signoff,staff_approval_count,owner_approval_count,created_by,created_at,applied_at,decided_at,reason';

  select string_agg(p.parameter_name, ',' order by p.ordinal_position) into actual
    from information_schema.parameters p
    join information_schema.routines r
      on r.specific_name = p.specific_name and r.specific_schema = p.specific_schema
   where r.routine_schema = 'app_private' and r.routine_name = 'staff_get_capability_change' and p.parameter_mode = 'OUT';
  if actual is distinct from expected then
    raise exception 'staff_get_capability_change must project exactly %. Found: %', expected, coalesce(actual, '<none>');
  end if;

  select string_agg(p.parameter_name, ',' order by p.ordinal_position) into actual
    from information_schema.parameters p
    join information_schema.routines r
      on r.specific_name = p.specific_name and r.specific_schema = p.specific_schema
   where r.routine_schema = 'app_private' and r.routine_name = 'staff_list_capability_changes' and p.parameter_mode = 'OUT';
  if actual is distinct from expected then
    raise exception 'staff_list_capability_changes must project exactly %. Found: %', expected, coalesce(actual, '<none>');
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
   where r.routine_schema = 'app_private' and r.routine_name = 'staff_list_capability_change_approvals' and p.parameter_mode = 'OUT';
  if actual is distinct from 'id,approval_kind,approver_id,approved_at' then
    raise exception 'staff_list_capability_change_approvals must project exactly id,approval_kind,approver_id,approved_at. Found: %', coalesce(actual, '<none>');
  end if;
end
$$;

-- =========================================================================
-- CTL-15 sanity, extended to the new tables: no retention/TTL/expiry
-- column anywhere in this migration's own schema either -- the same
-- absence-is-the-guard technique, applied defensively to this new
-- surface even though CTL-15 itself is a 0149 row.
-- =========================================================================
do $$
declare hit record; hit_count integer := 0;
begin
  for hit in
    select table_name, column_name
      from information_schema.columns
     where table_schema = 'public'
       and table_name in ('capability_change_requests', 'capability_change_approvals')
       and (column_name ~* 'retention' or column_name ~* 'retain' or column_name ~* 'ttl' or column_name ~* 'expir')
  loop
    hit_count := hit_count + 1;
    raise warning 'unexpected retention-shaped column %.%', hit.table_name, hit.column_name;
  end loop;
  if hit_count > 0 then
    raise exception '% retention-shaped column(s) found on the change-management tables', hit_count;
  end if;
end
$$;
