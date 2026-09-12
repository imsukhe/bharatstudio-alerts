-- L20: template-catalogue import pipeline (0106). Wrapped in
-- begin;...rollback; per this session's established lesson against
-- cross-test pollution in the shared disposable database.
begin;

insert into app_users (id, external_subject, display_name, created_at, updated_at) values
  ('0000000a-0000-4000-8000-000000000201', 'ext-tpl-001', 'Free Owner', now(), now()),
  ('0000000a-0000-4000-8000-000000000202', 'ext-tpl-002', 'Creator Owner', now(), now());

select channel_id from app_private.create_channel('0000000c-0000-4000-8000-000000000201'::uuid, '0000000a-0000-4000-8000-000000000201'::uuid, 'tplfreetest', 'Free Tier Channel');
select channel_id from app_private.create_channel('0000000c-0000-4000-8000-000000000202'::uuid, '0000000a-0000-4000-8000-000000000202'::uuid, 'tplcreatortest', 'Creator Tier Channel');

insert into channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at)
values ('0000000c-0000-4000-8000-000000000202'::uuid, 2, 'creator', 'individual_plan', jsonb_build_object('queueCount', 3), current_timestamp, current_timestamp);
-- the free channel keeps the 'free' row create_channel already inserted at version 1.

-- a first import creates a new row.
do $$
declare v_outcome text; v_id uuid; v_first_id uuid;
begin
  select outcome, entry_id into v_outcome, v_id from app_private.import_template_catalogue_entry(
    'BSA-T001', 'Minimal Clean Tip', 'Minimal Clean', 'free', '\x7b2276223a22312e30222c226c6179657273223a5b5d7d'::bytea
  );
  assert v_outcome = 'created', 'first import of a new external_key must report created, got: ' || v_outcome;
  v_first_id := v_id;

  -- re-running the exact same manifest entry is a true no-op: same
  -- outcome shape (skipped), same row id, no duplicate row created.
  select outcome, entry_id into v_outcome, v_id from app_private.import_template_catalogue_entry(
    'BSA-T001', 'Minimal Clean Tip', 'Minimal Clean', 'free', '\x7b2276223a22312e30222c226c6179657273223a5b5d7d'::bytea
  );
  assert v_outcome = 'skipped', 'a byte-identical re-import must report skipped, got: ' || v_outcome;
  assert v_id = v_first_id, 're-import must resolve to the same row id, not a duplicate';

  perform 1 from public.alert_template_catalogue_entries where external_key = 'BSA-T001';
  if (select count(*) from public.alert_template_catalogue_entries where external_key = 'BSA-T001') <> 1 then
    assert false, 'exactly one row must exist for external_key BSA-T001 after two identical imports';
  end if;
end
$$;

-- a changed template (different content) updates the same row rather
-- than forking a second one for the same external_key.
do $$
declare v_outcome text; v_id uuid; v_first_id uuid; v_count integer;
begin
  select id into v_first_id from public.alert_template_catalogue_entries where external_key = 'BSA-T001';

  select outcome, entry_id into v_outcome, v_id from app_private.import_template_catalogue_entry(
    'BSA-T001', 'Minimal Clean Tip (v2 art pass)', 'Minimal Clean', 'free',
    '\x7b2276223a22312e30222c226c6179657273223a5b7b226e6d223a2276322e6172747d5d7d'::bytea
  );
  assert v_outcome = 'updated', 'a content change on an existing external_key must report updated, got: ' || v_outcome;
  assert v_id = v_first_id, 'an update must keep the same row id, not create a new one';

  select count(*) into v_count from public.alert_template_catalogue_entries where external_key = 'BSA-T001';
  assert v_count = 1, 'an update must never leave a second row behind, got count: ' || v_count::text;

  perform 1 from public.alert_template_catalogue_entries where external_key = 'BSA-T001' and display_name = 'Minimal Clean Tip (v2 art pass)';
  assert found, 'the updated display_name must be persisted';
end
$$;

-- a malformed entry (unrecognised tier) is rejected loudly by the same
-- fail-closed rule template_tier_rank uses elsewhere, and never inserts
-- a partial row.
do $$
begin
  begin
    perform app_private.import_template_catalogue_entry('BSA-T-BAD-TIER', 'Bad Tier', 'Minimal Clean', 'enterprise', '\x7b7d'::bytea);
    assert false, 'an unrecognised tier must have raised';
  exception when others then
    assert sqlerrm like 'unrecognised tier for template entitlement:%', 'unexpected error: ' || sqlerrm;
  end;
  perform 1 from public.alert_template_catalogue_entries where external_key = 'BSA-T-BAD-TIER';
  assert not found, 'a rejected entry must not leave any row behind';
end
$$;

-- an oversized render document is rejected by the function's own check,
-- not just the table CHECK constraint (defense in depth, same as 0077).
do $$
declare v_oversized bytea;
begin
  select decode(repeat('41', 2000001), 'hex') into v_oversized;
  begin
    perform app_private.import_template_catalogue_entry('BSA-T-BAD-SIZE', 'Too Big', 'Minimal Clean', 'free', v_oversized);
    assert false, 'an oversized render document must have raised';
  exception when others then
    assert sqlerrm = 'invalid template render document', 'unexpected error: ' || sqlerrm;
  end;
  perform 1 from public.alert_template_catalogue_entries where external_key = 'BSA-T-BAD-SIZE';
  assert not found, 'a rejected oversized entry must not leave any row behind';
end
$$;

-- a blank external_key is rejected before ever reaching the table.
do $$
begin
  begin
    perform app_private.import_template_catalogue_entry('', 'No Key', 'Minimal Clean', 'free', '\x7b7d'::bytea);
    assert false, 'a blank external_key must have raised';
  exception when others then
    assert sqlerrm = 'invalid template external_key', 'unexpected error: ' || sqlerrm;
  end;
end
$$;

-- tier filtering: seed one entry per tier, then confirm each channel's
-- live list contains exactly the entries at or below its current tier.
do $$
begin
  perform app_private.import_template_catalogue_entry('BSA-T-FREE', 'Free Set', 'Minimal Clean', 'free', '\x7b2276223a2231227d'::bytea);
  perform app_private.import_template_catalogue_entry('BSA-T-PRO', 'Pro Set', 'Minimal Clean', 'pro', '\x7b2276223a2231227d'::bytea);
  perform app_private.import_template_catalogue_entry('BSA-T-CREATOR', 'Creator Set', 'Minimal Clean', 'creator', '\x7b2276223a2231227d'::bytea);
  perform app_private.import_template_catalogue_entry('BSA-T-STUDIO', 'Studio Set', 'Minimal Clean', 'studio', '\x7b2276223a2231227d'::bytea);
end
$$;

do $$
declare v_free_keys text[];
declare v_creator_keys text[];
begin
  -- list_templates_for_channel gates on can_access_channel, which reads
  -- app.user_id — each owner reads their own channel here.
  perform set_config('app.user_id', '0000000a-0000-4000-8000-000000000201', true);
  select array_agg(external_key order by external_key) into v_free_keys
    from app_private.list_templates_for_channel('0000000c-0000-4000-8000-000000000201'::uuid)
   where external_key like 'BSA-T-%';
  assert v_free_keys = array['BSA-T-FREE'], 'a free-tier channel must see only the free-tier entry, got: ' || coalesce(array_to_string(v_free_keys, ','), '<none>');

  perform set_config('app.user_id', '0000000a-0000-4000-8000-000000000202', true);
  select array_agg(external_key order by external_key) into v_creator_keys
    from app_private.list_templates_for_channel('0000000c-0000-4000-8000-000000000202'::uuid)
   where external_key like 'BSA-T-%';
  assert v_creator_keys = array['BSA-T-CREATOR', 'BSA-T-FREE', 'BSA-T-PRO'], 'a creator-tier channel must see free+pro+creator entries but not studio, got: ' || coalesce(array_to_string(v_creator_keys, ','), '<none>');
end
$$;

-- a downgrade is reflected on the very next read, matching 0077's
-- "no separate cleanup job" tier-gate philosophy — the row stays
-- imported, only visibility changes live.
do $$
declare v_creator_keys text[];
begin
  insert into channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at)
  values ('0000000c-0000-4000-8000-000000000202'::uuid, 3, 'free', 'individual_plan', jsonb_build_object('queueCount', 1), current_timestamp, current_timestamp);

  perform set_config('app.user_id', '0000000a-0000-4000-8000-000000000202', true);
  select array_agg(external_key order by external_key) into v_creator_keys
    from app_private.list_templates_for_channel('0000000c-0000-4000-8000-000000000202'::uuid)
   where external_key like 'BSA-T-%';
  assert v_creator_keys = array['BSA-T-FREE'], 'a downgraded channel must immediately see only free-tier entries, got: ' || coalesce(array_to_string(v_creator_keys, ','), '<none>');

  perform 1 from public.alert_template_catalogue_entries where external_key = 'BSA-T-CREATOR';
  assert found, 'a downgrade must not delete the catalogue row itself';
end
$$;

rollback;
