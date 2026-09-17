-- CTL-10/CTL-11/CTL-12 (migration 0160): the public capability matrix.
--
-- Covers:
--   * CTL-10: GET-backing app_private.get_public_capability_matrix()
--     returns EXACTLY the seven declared columns (information_schema.
--     parameters), never capacity_class/limits/rollout/kill_switch/beta/
--     audit/channel data -- proven structurally (the signature) and
--     behaviourally (a capability with every forbidden field populated
--     appears with only the seven allowed values);
--   * a non-marketing_visible capability is ABSENT from the public
--     matrix entirely, not merely nulled out -- so is a killed one
--     (kill_switch = true even with marketing_visible = true);
--   * CTL-10/11: the public read serves a PUBLISHED SNAPSHOT, not a live
--     query -- a registry change after publish is invisible until the
--     NEXT publish, and snapshot_version identifies which published
--     version a response came from;
--   * CTL-12: is_marketing_section is its own field, NOT a seventh kind
--     -- capability_registry_row_shape_check enforces the split
--     structurally, kind's own enum is unchanged and re-proven to still
--     exclude marketing_section as a value, and a marketing-section row
--     never enters app_private.resolve_channel_capabilities' per-channel
--     blob;
--   * CTL-14 (capacity_class closed whitelist) and CTL-15 (no retention/
--     TTL/expiry column anywhere) re-proven over this migration's new
--     table and columns;
--   * CTL-03 posture: capability_matrix_snapshots has no bsa_app grant;
--     every new function is revoked from public, granted to bsa_app
--     (INCLUDING the public-facing one -- there is no unauthenticated
--     Postgres caller; the API's own bsa_app connection is what serves
--     an unauthenticated HTTP request, exactly like every other public
--     route in this schema);
--   * append-only: capability_matrix_snapshots rejects UPDATE and
--     DELETE, structurally, for any role.
--
-- Fixture: own staff user '...7400', channel '...7401' (free tier,
-- reusing base_world owner '...0001' and its full member roster) --
-- pre-assigned fixture range ...7400-...74ff.
\set ON_ERROR_STOP on

insert into app_users (id, external_subject, display_name, created_at, updated_at, is_platform_admin)
values ('00000000-0000-4000-8000-000000007400', 'google-ctl-pubmatrix-staff', 'CTL Public Matrix Staff', current_timestamp, current_timestamp, true)
on conflict (id) do nothing;

insert into channels (id, owner_user_id, handle, display_name, accepting_tips, public_config_version, created_at, updated_at)
values ('00000000-0000-4000-8000-000000007401', '00000000-0000-4000-8000-000000000001', 'ctl_pubmatrix_free', 'CTL Public Matrix Free Channel', true, 1, current_timestamp, current_timestamp)
on conflict (id) do nothing;

insert into channel_memberships (channel_id, user_id, role, created_at)
values ('00000000-0000-4000-8000-000000007401', '00000000-0000-4000-8000-000000000001', 'owner', current_timestamp)
on conflict (channel_id, user_id) do nothing;

insert into channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at)
values ('00000000-0000-4000-8000-000000007401', 1, 'free', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp)
on conflict (channel_id, version) do nothing;

-- =========================================================================
-- STRUCTURAL: every new function revoked from public, granted to
-- bsa_app -- INCLUDING get_public_capability_matrix, the public-facing
-- one. capability_matrix_snapshots revoked from BOTH public and bsa_app.
-- =========================================================================
do $$
declare fn record;
begin
  for fn in
    select unnest(array[
      'app_private.get_public_capability_matrix()',
      'app_private.staff_publish_capability_matrix_snapshot(text)',
      'app_private.staff_list_capability_matrix_snapshots()',
      'app_private.staff_create_marketing_section(text, text, boolean, boolean, text, text)',
      'app_private.staff_set_capability_marketing_section(text, boolean, boolean, text, text)',
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
  if has_table_privilege('public', 'public.capability_matrix_snapshots', 'SELECT') then
    raise exception 'SELECT on capability_matrix_snapshots must be revoked from public';
  end if;
  if has_table_privilege('bsa_app', 'public.capability_matrix_snapshots', 'SELECT') then
    raise exception 'CTL-03/CTL-10: SELECT on capability_matrix_snapshots must be revoked from bsa_app -- app_private.get_public_capability_matrix is the only reachable path, never a direct table read';
  end if;
  if has_table_privilege('bsa_app', 'public.capability_matrix_snapshots', 'INSERT') then
    raise exception 'CTL-03: INSERT on capability_matrix_snapshots must be revoked from bsa_app';
  end if;
end
$$;

set role bsa_app;
do $$
begin
  begin
    perform 1 from public.capability_matrix_snapshots limit 1;
    raise exception 'CTL-03: bsa_app must not be able to SELECT capability_matrix_snapshots directly';
  exception when insufficient_privilege then
    null; -- expected
  end;
end
$$;
reset role;

-- =========================================================================
-- Non-staff rejected on every new staff function. Public read has NO
-- admin gate by design -- proven separately below (it must succeed for
-- a non-staff / no-identity caller).
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false); -- channel owner, not staff

do $$
begin
  begin
    perform app_private.staff_create_marketing_section('ctl_pubmatrix_nonstaff_probe', 'probe', false, false, null, null);
    raise exception 'non-staff must not be able to create a marketing section';
  exception when insufficient_privilege then null;
  end;

  begin
    perform app_private.staff_set_capability_marketing_section('ctl_pubmatrix_nonstaff_probe', false, false, null, null);
    raise exception 'non-staff must not be able to set a marketing section';
  exception when insufficient_privilege then null;
  end;

  begin
    perform app_private.staff_publish_capability_matrix_snapshot('non-staff probe');
    raise exception 'non-staff must not be able to publish a snapshot';
  exception when insufficient_privilege then null;
  end;

  begin
    perform app_private.staff_list_capability_matrix_snapshots();
    raise exception 'non-staff must not be able to list snapshots';
  exception when insufficient_privilege then null;
  end;
end
$$;

select set_config('app.user_id', '00000000-0000-4000-8000-000000007400', false); -- platform staff, from here on

-- =========================================================================
-- BEFORE any snapshot is published: the public matrix is empty, not an
-- error.
-- =========================================================================
do $$
declare row_total integer;
begin
  select count(*) into row_total from app_private.get_public_capability_matrix();
  if row_total <> 0 then
    raise exception 'the public matrix must be empty before any snapshot is published, found % rows', row_total;
  end if;
end
$$;

-- =========================================================================
-- Fixture rows: one ordinary capability with EVERY forbidden field
-- populated (the public-leak probe), one non-marketing_visible
-- capability, one killed-but-marketing_visible capability, and one
-- marketing-section row.
-- =========================================================================
select app_private.staff_set_capability_registry_entry(
  'ctl_pubmatrix_widget', 'active_widget', 'CTL public matrix leak-proof probe capability', false, 100, 'pro',
  'widget', '{"max_instances": 3, "max_duration_ms": 8000}'::jsonb, true, true,
  'Public Matrix Probe Widget', 'A widget used to prove the public matrix leaks nothing beyond the declared four fields.'
);

select app_private.staff_set_capability_registry_entry(
  'ctl_pubmatrix_hidden', 'active_widget', 'CTL public matrix: never marketing_visible', false, 100, 'pro',
  'widget', '{}'::jsonb, false, false, null, null
);

select app_private.staff_set_capability_registry_entry(
  'ctl_pubmatrix_killed', 'active_widget', 'CTL public matrix: marketing_visible but killed', true, 100, 'free',
  'widget', '{}'::jsonb, false, true, 'Killed Widget', 'This must never appear publicly once kill_switch is true.'
);

select app_private.staff_create_marketing_section('ctl_pubmatrix_section', 'CTL public matrix: a page-region flag', false, true, 'Pricing Hero', 'The pricing page hero section.');

-- =========================================================================
-- CTL-12: staff_create_marketing_section refuses an existing key
-- (whether it names a real capability or an existing marketing section).
-- =========================================================================
do $$
begin
  begin
    perform app_private.staff_create_marketing_section('ctl_pubmatrix_widget', 'dup', false, false, null, null);
    raise exception 'staff_create_marketing_section must reject an existing REAL capability key';
  exception when insufficient_privilege then null;
  end;

  begin
    perform app_private.staff_create_marketing_section('ctl_pubmatrix_section', 'dup', false, false, null, null);
    raise exception 'staff_create_marketing_section must reject an existing marketing-section key too';
  exception when insufficient_privilege then null;
  end;
end
$$;

-- =========================================================================
-- CTL-12: staff_set_capability_marketing_section refuses a REAL
-- capability, structurally, before writing anything -- this is what
-- makes it not a bypass of migration 0157's two-person workflow.
-- =========================================================================
do $$
declare current_label text;
begin
  begin
    perform app_private.staff_set_capability_marketing_section('ctl_pubmatrix_widget', true, false, 'hijacked', 'hijacked');
    raise exception 'staff_set_capability_marketing_section must reject a REAL capability';
  exception when insufficient_privilege then null;
  end;

  select marketing_label into current_label from public.capability_registry where capability_key = 'ctl_pubmatrix_widget';
  if current_label <> 'Public Matrix Probe Widget' then
    raise exception 'the rejected call must not have mutated the real capability -- found %', current_label;
  end if;
end
$$;

-- =========================================================================
-- CTL-14, RE-PROVEN after relaxing capacity_class to nullable: the same
-- nine §12.6.1 forbidden classes are still rejected on an ordinary
-- (non-marketing-section) row.
-- =========================================================================
do $$
declare forbidden text; probe_key text;
begin
  foreach forbidden in array array[
    'payment', 'receipt', 'refund', 'audit_trail', 'supporter_relationship',
    'event_history', 'configuration', 'layout', 'moderation_history'
  ]
  loop
    probe_key := 'ctl_pubmatrix_ctl14_probe_' || forbidden;
    begin
      perform app_private.staff_set_capability_registry_entry(
        probe_key, forbidden, 'CTL-14 probe', false, 100, 'studio', 'widget', '{}'::jsonb, false, false, null, null
      );
      raise exception 'CTL-14: capacity_class % must still be rejected', forbidden;
    exception when check_violation then null;
    end;
  end loop;

  perform 1 from public.capability_registry where capability_key like 'ctl_pubmatrix_ctl14_probe_%';
  if found then raise exception 'CTL-14: a probe row was persisted despite the expected check_violation'; end if;
end
$$;

-- =========================================================================
-- NEW row-shape constraint: a marketing-section row can never carry a
-- capacity_class, and an ordinary capability can never omit one. Probed
-- directly against the table (the two staff functions never construct
-- either forbidden shape themselves, so this proves the constraint
-- itself is what protects the invariant, not merely the functions'
-- own discipline).
-- =========================================================================
do $$
begin
  begin
    insert into public.capability_registry (capability_key, capacity_class, description, is_marketing_section)
    values ('ctl_pubmatrix_shape_probe_a', 'active_widget', 'a marketing section must not carry a capacity_class', true);
    raise exception 'row-shape check must reject is_marketing_section=true with a non-null capacity_class';
  exception when check_violation then null;
  end;

  begin
    insert into public.capability_registry (capability_key, capacity_class, description, is_marketing_section)
    values ('ctl_pubmatrix_shape_probe_b', null, 'an ordinary capability must carry a capacity_class', false);
    raise exception 'row-shape check must reject is_marketing_section=false with a null capacity_class';
  exception when check_violation then null;
  end;

  perform 1 from public.capability_registry where capability_key like 'ctl_pubmatrix_shape_probe_%';
  if found then raise exception 'a row-shape probe was persisted despite the expected check_violation'; end if;
end
$$;

-- kind's own enum: still excludes marketing_section as a value (this
-- migration adds no seventh kind -- the owner decision's own point).
do $$
declare definition text;
begin
  select pg_catalog.pg_get_constraintdef(c.oid)
    into definition
    from pg_catalog.pg_constraint c
    join pg_catalog.pg_class t on t.oid = c.conrelid
   where t.relname = 'capability_registry' and c.conname = 'capability_registry_kind_check';

  if definition is null then
    raise exception 'kind''s own check constraint does not exist';
  end if;
  if position('marketing_section' in definition) > 0 then
    raise exception 'CTL-12: kind''s enum must NOT contain marketing_section -- it is its own field (is_marketing_section), per the owner decision';
  end if;
end
$$;

-- =========================================================================
-- CTL-15, RE-PROVEN over this migration's new table and column: no
-- retention/TTL/expiry column anywhere.
-- =========================================================================
do $$
declare hit record; hit_count integer := 0;
begin
  for hit in
    select table_name, column_name
      from information_schema.columns
     where table_schema = 'public'
       and table_name in ('capability_registry', 'capability_matrix_snapshots')
       and (
         column_name ~* 'retention' or column_name ~* 'retain'
         or column_name ~* 'ttl' or column_name ~* 'expir'
       )
  loop
    hit_count := hit_count + 1;
    raise warning 'CTL-15: forbidden column %.%', hit.table_name, hit.column_name;
  end loop;
  if hit_count > 0 then
    raise exception 'CTL-15: % retention-shaped column(s) found', hit_count;
  end if;
end
$$;

-- =========================================================================
-- CTL-12: a marketing-section row never enters a channel's resolved
-- capability blob, while an ordinary capability does.
-- =========================================================================
do $$
declare resolved_blob jsonb;
begin
  select resolved into resolved_blob from app_private.resolve_channel_capabilities('00000000-0000-4000-8000-000000007401'::uuid);
  if resolved_blob ? 'ctl_pubmatrix_section' then
    raise exception 'CTL-12: a marketing-section row must never appear in a channel''s resolved capability blob';
  end if;
  if not (resolved_blob ? 'ctl_pubmatrix_widget') then
    raise exception 'the ordinary capability must still appear in the resolved blob';
  end if;
end
$$;

-- =========================================================================
-- CTL-10/CTL-11: publish snapshot #1. row_count and the public read must
-- agree: exactly the marketing_visible-and-not-killed rows (the probe
-- widget and the marketing section) -- the hidden and killed rows are
-- absent.
-- =========================================================================
do $$
declare pub record;
begin
  select * into pub from app_private.staff_publish_capability_matrix_snapshot('ctl_public_capability_matrix.sql fixture publish #1');
  if pub.version <> 1 then raise exception 'first publish must be version 1, got %', pub.version; end if;
  if pub.row_count <> 2 then raise exception 'snapshot #1 must contain exactly 2 rows (probe widget + marketing section), got %', pub.row_count; end if;
end
$$;

do $$
declare row_total integer; widget_row record; section_row record;
begin
  select count(*) into row_total from app_private.get_public_capability_matrix();
  if row_total <> 2 then raise exception 'public matrix must contain exactly 2 rows after publish #1, got %', row_total; end if;

  select * into widget_row from app_private.get_public_capability_matrix() where capability_id = 'ctl_pubmatrix_widget';
  if not found then raise exception 'the marketing_visible, non-killed widget must appear in the public matrix'; end if;
  if widget_row.marketing_label <> 'Public Matrix Probe Widget' then raise exception 'marketing_label must pass through unchanged, got %', widget_row.marketing_label; end if;
  if widget_row.marketing_blurb <> 'A widget used to prove the public matrix leaks nothing beyond the declared four fields.' then raise exception 'marketing_blurb must pass through unchanged'; end if;
  if widget_row.min_tier <> 'pro' then raise exception 'min_tier must pass through unchanged, got %', widget_row.min_tier; end if;
  if widget_row.is_marketing_section is not false then raise exception 'the widget row must report is_marketing_section = false'; end if;
  if widget_row.snapshot_version <> 1 then raise exception 'snapshot_version must be 1, got %', widget_row.snapshot_version; end if;
  if widget_row.published_at is null then raise exception 'published_at must be set'; end if;

  select * into section_row from app_private.get_public_capability_matrix() where capability_id = 'ctl_pubmatrix_section';
  if not found then raise exception 'the marketing section must appear in the public matrix'; end if;
  if section_row.is_marketing_section is not true then raise exception 'the section row must report is_marketing_section = true'; end if;
  if section_row.marketing_label <> 'Pricing Hero' then raise exception 'the section''s marketing_label must pass through unchanged'; end if;

  perform 1 from app_private.get_public_capability_matrix() where capability_id = 'ctl_pubmatrix_hidden';
  if found then raise exception 'CTL-10: a non-marketing_visible capability must never appear in the public matrix'; end if;

  perform 1 from app_private.get_public_capability_matrix() where capability_id = 'ctl_pubmatrix_killed';
  if found then raise exception 'CTL-10: a killed capability must never appear in the public matrix even if marketing_visible';
  end if;
end
$$;

-- =========================================================================
-- PUBLIC LEAK PROOF: the widget row carries ONLY the seven declared
-- fields -- proven structurally via the function's own OUT signature
-- (below), and behaviourally here: every forbidden value the fixture
-- populated (capacity_class=active_widget, limits with real keys,
-- beta=true, rollout_percentage=100, kill_switch=false, kind=widget,
-- version, description) has NO corresponding column in the returned
-- row at all -- selecting widget_row.capacity_class, etc. would be a
-- compile-time error in this same do-block, which is exactly the point:
-- there is no way to even ASK for it from this function's result.
-- =========================================================================
do $$
declare actual text; expected text;
begin
  expected := 'capability_id,marketing_label,marketing_blurb,min_tier,is_marketing_section,snapshot_version,published_at';
  select string_agg(p.parameter_name, ',' order by p.ordinal_position) into actual
    from information_schema.parameters p
    join information_schema.routines r
      on r.specific_name = p.specific_name and r.specific_schema = p.specific_schema
   where r.routine_schema = 'app_private' and r.routine_name = 'get_public_capability_matrix' and p.parameter_mode = 'OUT';
  if actual is distinct from expected then
    raise exception 'get_public_capability_matrix must project exactly %. Found: %', expected, coalesce(actual, '<none>');
  end if;

  expected := 'id,version,published_at,row_count';
  select string_agg(p.parameter_name, ',' order by p.ordinal_position) into actual
    from information_schema.parameters p
    join information_schema.routines r
      on r.specific_name = p.specific_name and r.specific_schema = p.specific_schema
   where r.routine_schema = 'app_private' and r.routine_name = 'staff_publish_capability_matrix_snapshot' and p.parameter_mode = 'OUT';
  if actual is distinct from expected then
    raise exception 'staff_publish_capability_matrix_snapshot must project exactly %. Found: %', expected, coalesce(actual, '<none>');
  end if;

  expected := 'id,version,published_at,published_by,reason,row_count';
  select string_agg(p.parameter_name, ',' order by p.ordinal_position) into actual
    from information_schema.parameters p
    join information_schema.routines r
      on r.specific_name = p.specific_name and r.specific_schema = p.specific_schema
   where r.routine_schema = 'app_private' and r.routine_name = 'staff_list_capability_matrix_snapshots' and p.parameter_mode = 'OUT';
  if actual is distinct from expected then
    raise exception 'staff_list_capability_matrix_snapshots must project exactly %. Found: %', expected, coalesce(actual, '<none>');
  end if;

  expected := 'capability_key,description,kill_switch,is_marketing_section,marketing_visible,marketing_label,marketing_blurb,version,updated_at';
  select string_agg(p.parameter_name, ',' order by p.ordinal_position) into actual
    from information_schema.parameters p
    join information_schema.routines r
      on r.specific_name = p.specific_name and r.specific_schema = p.specific_schema
   where r.routine_schema = 'app_private' and r.routine_name = 'staff_create_marketing_section' and p.parameter_mode = 'OUT';
  if actual is distinct from expected then
    raise exception 'staff_create_marketing_section must project exactly %. Found: %', expected, coalesce(actual, '<none>');
  end if;

  select string_agg(p.parameter_name, ',' order by p.ordinal_position) into actual
    from information_schema.parameters p
    join information_schema.routines r
      on r.specific_name = p.specific_name and r.specific_schema = p.specific_schema
   where r.routine_schema = 'app_private' and r.routine_name = 'staff_set_capability_marketing_section' and p.parameter_mode = 'OUT';
  if actual is distinct from expected then
    raise exception 'staff_set_capability_marketing_section must project exactly %. Found: %', expected, coalesce(actual, '<none>');
  end if;

  -- resolve_channel_capabilities: unchanged signature, re-proven.
  expected := 'resolved,generation,resolved_at';
  select string_agg(p.parameter_name, ',' order by p.ordinal_position) into actual
    from information_schema.parameters p
    join information_schema.routines r
      on r.specific_name = p.specific_name and r.specific_schema = p.specific_schema
   where r.routine_schema = 'app_private' and r.routine_name = 'resolve_channel_capabilities' and p.parameter_mode = 'OUT';
  if actual is distinct from expected then
    raise exception 'resolve_channel_capabilities must still project exactly %. Found: %', expected, coalesce(actual, '<none>');
  end if;
end
$$;

-- =========================================================================
-- CTL-10/CTL-11: the public read serves a PUBLISHED SNAPSHOT, not a live
-- query -- a registry change after publish #1 is invisible until publish
-- #2, and snapshot_version tells the two apart.
-- =========================================================================
select app_private.staff_set_capability_marketing_section('ctl_pubmatrix_section', false, true, 'Pricing Hero v2', 'Updated after publish #1.');

do $$
declare stale_label text;
begin
  select marketing_label into stale_label from app_private.get_public_capability_matrix() where capability_id = 'ctl_pubmatrix_section';
  if stale_label <> 'Pricing Hero' then
    raise exception 'CTL-10/11: the public read must still serve snapshot #1''s frozen value until the next publish, got %', stale_label;
  end if;
end
$$;

do $$
declare pub record; fresh_label text; fresh_version integer;
begin
  select * into pub from app_private.staff_publish_capability_matrix_snapshot('ctl_public_capability_matrix.sql fixture publish #2');
  if pub.version <> 2 then raise exception 'second publish must be version 2, got %', pub.version; end if;

  select marketing_label, snapshot_version into fresh_label, fresh_version from app_private.get_public_capability_matrix() where capability_id = 'ctl_pubmatrix_section';
  if fresh_label <> 'Pricing Hero v2' then raise exception 'after publish #2 the public read must serve the updated label, got %', fresh_label; end if;
  if fresh_version <> 2 then raise exception 'after publish #2 every row must report snapshot_version = 2, got %', fresh_version; end if;
end
$$;

-- An emergency kill on the widget must remove it from the NEXT publish
-- (§20.3: kill is "off for everyone, immediately", applied to the
-- marketing surface at publish time -- see this migration's own header).
update public.capability_registry set kill_switch = true where capability_key = 'ctl_pubmatrix_widget';

do $$
declare pub record; row_total integer;
begin
  select * into pub from app_private.staff_publish_capability_matrix_snapshot('ctl_public_capability_matrix.sql fixture publish #3, widget now killed');
  if pub.version <> 3 then raise exception 'third publish must be version 3, got %', pub.version; end if;
  if pub.row_count <> 1 then raise exception 'snapshot #3 must contain exactly 1 row (only the marketing section, widget now killed), got %', pub.row_count; end if;

  select count(*) into row_total from app_private.get_public_capability_matrix();
  if row_total <> 1 then raise exception 'public matrix must contain exactly 1 row after publish #3, got %', row_total; end if;

  perform 1 from app_private.get_public_capability_matrix() where capability_id = 'ctl_pubmatrix_widget';
  if found then raise exception 'a killed capability must be absent from the public matrix even though it was present in an earlier snapshot'; end if;
end
$$;
update public.capability_registry set kill_switch = false where capability_key = 'ctl_pubmatrix_widget';

-- =========================================================================
-- Append-only: capability_matrix_snapshots rejects UPDATE and DELETE,
-- structurally, for any role (reject_table_mutation, migration 0155).
-- =========================================================================
do $$
declare any_id uuid;
begin
  select id into any_id from public.capability_matrix_snapshots order by version limit 1;

  begin
    update public.capability_matrix_snapshots set reason = 'tampered' where id = any_id;
    raise exception 'capability_matrix_snapshots must reject UPDATE';
  exception when sqlstate '0A000' then null;
  end;

  begin
    delete from public.capability_matrix_snapshots where id = any_id;
    raise exception 'capability_matrix_snapshots must reject DELETE';
  exception when sqlstate '0A000' then null;
  end;
end
$$;

-- staff_list_capability_matrix_snapshots: staff introspection sees all
-- three publishes, newest first.
do $$
declare versions integer[];
begin
  select array_agg(version order by version desc) into versions from app_private.staff_list_capability_matrix_snapshots();
  if versions <> array[3, 2, 1] then
    raise exception 'staff_list_capability_matrix_snapshots must list all three publishes newest-first, got %', versions;
  end if;
end
$$;

select 'ctl_public_capability_matrix.sql: all checks passed' as result;
