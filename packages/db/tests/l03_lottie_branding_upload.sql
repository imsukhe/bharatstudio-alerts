-- L03: Studio-tier Lottie/custom branding upload (0077). Wrapped in
-- begin;...rollback; per this session's established lesson against
-- cross-test pollution in the shared disposable database.
begin;

insert into app_users (id, external_subject, display_name, created_at, updated_at) values
  ('0000000a-0000-4000-8000-0000000000f1', 'ext-lot-f1', 'Free Owner', now(), now()),
  ('0000000a-0000-4000-8000-0000000000f2', 'ext-lot-f2', 'Studio Owner', now(), now());

select channel_id from app_private.create_channel('0000000c-0000-4000-8000-0000000000f1'::uuid, '0000000a-0000-4000-8000-0000000000f1'::uuid, 'lottiefreetest', 'Free Tier Channel');
select channel_id from app_private.create_channel('0000000c-0000-4000-8000-0000000000f2'::uuid, '0000000a-0000-4000-8000-0000000000f2'::uuid, 'lottiestudiotest', 'Studio Tier Channel');

insert into channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at)
values ('0000000c-0000-4000-8000-0000000000f2'::uuid, 2, 'studio', 'individual_plan', jsonb_build_object('queueCount', 10), current_timestamp, current_timestamp);

-- a free-tier channel's owner is rejected, even though the caller's own
-- channel-membership role check would otherwise pass.
do $$
begin
  perform set_config('app.user_id', '0000000a-0000-4000-8000-0000000000f1', true);
  begin
    perform app_private.store_channel_lottie_asset('0000000c-0000-4000-8000-0000000000f1'::uuid, 'celebration', '\x7b7d'::bytea);
    assert false, 'a free-tier upload must have raised';
  exception when others then
    assert sqlerrm = 'custom branding requires the Studio tier', 'unexpected error: ' || sqlerrm;
  end;
end
$$;

-- a caller with no membership on the channel at all is rejected before
-- the tier check ever runs.
do $$
begin
  perform set_config('app.user_id', '0000000a-0000-4000-8000-0000000000f1', true);
  begin
    perform app_private.store_channel_lottie_asset('0000000c-0000-4000-8000-0000000000f2'::uuid, 'celebration', '\x7b7d'::bytea);
    assert false, 'a non-member upload must have raised';
  exception when others then
    assert sqlerrm = 'not authorized to manage this channel''s branding', 'unexpected error: ' || sqlerrm;
  end;
end
$$;

-- a Studio-tier owner can upload; the artifact id stays stable across a
-- re-upload to the same slot (content changes, handle does not).
do $$
declare v_first_id uuid; v_second_id uuid; v_size integer;
begin
  perform set_config('app.user_id', '0000000a-0000-4000-8000-0000000000f2', true);
  v_first_id := app_private.store_channel_lottie_asset('0000000c-0000-4000-8000-0000000000f2'::uuid, 'celebration', '\x7b2276223a357d'::bytea);
  v_second_id := app_private.store_channel_lottie_asset('0000000c-0000-4000-8000-0000000000f2'::uuid, 'celebration', '\x7b2276223a352c226e223a327d'::bytea);
  assert v_first_id = v_second_id, 'artifact id must stay stable across a re-upload to the same slot';

  select byte_size into v_size from app_private.list_channel_lottie_assets('0000000c-0000-4000-8000-0000000000f2'::uuid) where display_style = 'celebration';
  assert v_size = 13, 'listed size must reflect the latest upload, got: ' || v_size::text;
end
$$;

-- an invalid display_style is rejected by the storage function itself,
-- not just by an upstream API-layer enum check.
do $$
begin
  perform set_config('app.user_id', '0000000a-0000-4000-8000-0000000000f2', true);
  begin
    perform app_private.store_channel_lottie_asset('0000000c-0000-4000-8000-0000000000f2'::uuid, 'not_a_real_style', '\x7b7d'::bytea);
    assert false, 'an invalid display_style must have raised';
  exception when others then
    assert sqlerrm = 'invalid Lottie asset', 'unexpected error: ' || sqlerrm;
  end;
end
$$;

-- an oversized payload is rejected by the storage function's own check,
-- not just the table CHECK constraint (defense in depth: the function
-- must reject before ever attempting the insert).
do $$
declare v_oversized bytea;
begin
  perform set_config('app.user_id', '0000000a-0000-4000-8000-0000000000f2', true);
  select decode(repeat('41', 2000001), 'hex') into v_oversized;
  begin
    perform app_private.store_channel_lottie_asset('0000000c-0000-4000-8000-0000000000f2'::uuid, 'banner', v_oversized);
    assert false, 'an oversized asset must have raised';
  exception when others then
    assert sqlerrm = 'invalid Lottie asset', 'unexpected error: ' || sqlerrm;
  end;
end
$$;

-- the overlay-scoped read path: session-fingerprint-gated, and the same
-- asset is reachable both from the list and the by-id serve function.
do $$
declare v_overlay_id uuid := '0000000e-0000-4000-8000-0000000000f2'::uuid;
declare v_fingerprint text := encode(sha256('l03-lottie-test-token'::bytea), 'hex');
declare v_artifact_id uuid;
declare v_bytes bytea; v_mime text;
begin
  insert into overlay_sessions (id, channel_id, token_fingerprint, expires_at, created_at)
  values (v_overlay_id, '0000000c-0000-4000-8000-0000000000f2'::uuid, v_fingerprint, current_timestamp + interval '7 days', current_timestamp);

  select artifact_id into v_artifact_id from app_private.list_overlay_lottie_assets(v_overlay_id, v_fingerprint) where display_style = 'celebration';
  assert v_artifact_id is not null, 'the overlay session must see the uploaded celebration slot';

  select lottie_bytes, mime_type into v_bytes, v_mime from app_private.get_overlay_lottie_asset(v_overlay_id, v_fingerprint, v_artifact_id);
  assert v_mime = 'application/json', 'served mime type must be application/json, got: ' || coalesce(v_mime, '<null>');
  assert v_bytes is not null, 'served bytes must not be null';

  -- a wrong fingerprint (as if a different/expired token were used) sees nothing
  perform 1 from app_private.list_overlay_lottie_assets(v_overlay_id, 'not-the-real-fingerprint');
  assert not found, 'a mismatched token fingerprint must see no assets';
end
$$;

-- downgrade: the very next overlay read stops serving the asset with no
-- separate cleanup job, while the row itself remains stored (so a later
-- re-upgrade needs no re-upload).
do $$
declare v_overlay_id uuid := '0000000e-0000-4000-8000-0000000000f2'::uuid;
declare v_fingerprint text := encode(sha256('l03-lottie-test-token'::bytea), 'hex');
declare v_list_count integer; v_stored_count integer;
begin
  insert into channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at)
  values ('0000000c-0000-4000-8000-0000000000f2'::uuid, 3, 'pro', 'individual_plan', jsonb_build_object('queueCount', 3), current_timestamp, current_timestamp);

  select count(*) into v_list_count from app_private.list_overlay_lottie_assets(v_overlay_id, v_fingerprint);
  assert v_list_count = 0, 'a downgraded channel''s overlay must see zero lottie assets, got: ' || v_list_count::text;

  select count(*) into v_stored_count from (
    select 1 from app_private.list_channel_lottie_assets('0000000c-0000-4000-8000-0000000000f2'::uuid)
  ) x;
  -- the owner-facing list is NOT tier-gated (it shows what is stored
  -- regardless of current tier, so a downgraded owner can still see —
  -- and, on re-upgrade, immediately regain — what they uploaded).
  assert v_stored_count = 1, 'the stored asset must remain listed to its owner after a downgrade, got: ' || v_stored_count::text;
end
$$;

-- delete removes the slot entirely.
do $$
declare v_deleted boolean;
begin
  perform set_config('app.user_id', '0000000a-0000-4000-8000-0000000000f2', true);
  v_deleted := app_private.delete_channel_lottie_asset('0000000c-0000-4000-8000-0000000000f2'::uuid, 'celebration');
  assert v_deleted, 'delete must report true for an existing slot';
  perform 1 from app_private.list_channel_lottie_assets('0000000c-0000-4000-8000-0000000000f2'::uuid) where display_style = 'celebration';
  assert not found, 'the deleted slot must no longer be listed';

  v_deleted := app_private.delete_channel_lottie_asset('0000000c-0000-4000-8000-0000000000f2'::uuid, 'celebration');
  assert not v_deleted, 'deleting an already-absent slot must report false, not raise';
end
$$;

rollback;
