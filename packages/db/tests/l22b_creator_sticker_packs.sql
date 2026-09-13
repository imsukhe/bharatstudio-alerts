-- L22 gap-fill: creator-approved sticker packs, tier quotas,
-- scan-plus-attest, and the Studio review-workflow status gate (0119).
-- Wrapped in begin;...rollback; per this session's established lesson
-- against cross-test pollution in the shared disposable database.
begin;

insert into app_users (id, external_subject, display_name, created_at, updated_at) values
  ('0000000a-0000-4000-8000-000000000401', 'ext-pack-001', 'Pro Owner', now(), now()),
  ('0000000a-0000-4000-8000-000000000402', 'ext-pack-002', 'Creator Owner', now(), now()),
  ('0000000a-0000-4000-8000-000000000403', 'ext-pack-003', 'Studio Owner', now(), now()),
  ('0000000a-0000-4000-8000-000000000404', 'ext-pack-004', 'Non Member', now(), now());

select channel_id from app_private.create_channel('0000000c-0000-4000-8000-000000000401'::uuid, '0000000a-0000-4000-8000-000000000401'::uuid, 'packprotest', 'Pro Pack Channel');
select channel_id from app_private.create_channel('0000000c-0000-4000-8000-000000000402'::uuid, '0000000a-0000-4000-8000-000000000402'::uuid, 'packcreatortest', 'Creator Pack Channel');
select channel_id from app_private.create_channel('0000000c-0000-4000-8000-000000000403'::uuid, '0000000a-0000-4000-8000-000000000403'::uuid, 'packstudiotest', 'Studio Pack Channel');

insert into channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at) values
  ('0000000c-0000-4000-8000-000000000401'::uuid, 2, 'pro', 'individual_plan', jsonb_build_object('queueCount', 3), current_timestamp, current_timestamp),
  ('0000000c-0000-4000-8000-000000000402'::uuid, 2, 'creator', 'individual_plan', jsonb_build_object('queueCount', 3), current_timestamp, current_timestamp),
  ('0000000c-0000-4000-8000-000000000403'::uuid, 2, 'studio', 'individual_plan', jsonb_build_object('queueCount', 3), current_timestamp, current_timestamp);
-- the free-tier assertion below relies on create_channel's own default 'free' row for a channel we never retier.
select channel_id from app_private.create_channel('0000000c-0000-4000-8000-000000000499'::uuid, '0000000a-0000-4000-8000-000000000401'::uuid, 'packfreetest', 'Free Pack Channel');

-- =========================================================================
-- Free tier: creator packs are not available at all (limit 0).
-- =========================================================================
do $$
begin
  perform set_config('app.user_id', '0000000a-0000-4000-8000-000000000401', true);
  begin
    perform app_private.import_creator_pack_sticker('0000000c-0000-4000-8000-000000000499'::uuid, 'Free Attempt', 'Reaction', '\x7b2276223a22312e30222c226c6179657273223a5b5d7d'::bytea, false);
    assert false, 'a Free-tier channel must not be able to upload a creator-pack sticker';
  exception when others then
    assert sqlerrm like 'creator packs are not available%', 'unexpected error: ' || sqlerrm;
  end;
end
$$;

-- =========================================================================
-- Pro tier: pack allowed, no attestation required, limit is 10.
-- =========================================================================
do $$
declare v_outcome text; v_id uuid; v_status text;
begin
  perform set_config('app.user_id', '0000000a-0000-4000-8000-000000000401', true);
  select outcome, entry_id, status into v_outcome, v_id, v_status from app_private.import_creator_pack_sticker(
    '0000000c-0000-4000-8000-000000000401'::uuid, 'Pro Wave', 'Reaction', '\x7b2276223a22312e30222c226c6179657273223a5b5d7d'::bytea, false
  );
  assert v_outcome = 'created', 'a Pro-tier upload without attestation must succeed, got: ' || v_outcome;
  assert v_status = 'active', 'a Pro-tier upload must be immediately active, got: ' || v_status;
end
$$;

-- =========================================================================
-- Creator tier: attestation required.
-- =========================================================================
do $$
begin
  perform set_config('app.user_id', '0000000a-0000-4000-8000-000000000402', true);
  begin
    perform app_private.import_creator_pack_sticker('0000000c-0000-4000-8000-000000000402'::uuid, 'Unattested', 'Reaction', '\x7b2276223a22312e30222c226c6179657273223a5b5d7d'::bytea, false);
    assert false, 'a Creator-tier upload without attestation must be rejected';
  exception when others then
    assert sqlerrm like 'creator attestation is required%', 'unexpected error: ' || sqlerrm;
  end;
end
$$;

do $$
declare v_outcome text; v_status text;
begin
  perform set_config('app.user_id', '0000000a-0000-4000-8000-000000000402', true);
  select outcome, status into v_outcome, v_status from app_private.import_creator_pack_sticker(
    '0000000c-0000-4000-8000-000000000402'::uuid, 'Attested Fire', 'Reaction', '\x7b2276223a22312e30222c226c6179657273223a5b5d7d'::bytea, true
  );
  assert v_outcome = 'created', 'a Creator-tier upload with attestation must succeed, got: ' || v_outcome;
  assert v_status = 'active', 'a Creator-tier upload must be immediately active, got: ' || v_status;
end
$$;

-- =========================================================================
-- Studio tier: review workflow — a new upload starts pending_review and
-- is invisible to the viewer-facing listing until reviewed.
-- =========================================================================
do $$
declare v_id uuid; v_status text; v_public_count integer;
begin
  perform set_config('app.user_id', '0000000a-0000-4000-8000-000000000403', true);
  select entry_id, status into v_id, v_status from app_private.import_creator_pack_sticker(
    '0000000c-0000-4000-8000-000000000403'::uuid, 'Studio Crown', 'Hype', '\x7b2276223a22312e30222c226c6179657273223a5b5d7d'::bytea, true
  );
  assert v_status = 'pending_review', 'a Studio-tier upload must start pending_review, got: ' || v_status;

  select count(*) into v_public_count from app_private.list_public_creator_pack_for_channel('0000000c-0000-4000-8000-000000000403'::uuid) where display_name = 'Studio Crown';
  assert v_public_count = 0, 'a pending-review pack sticker must not be viewer-visible';

  perform app_private.review_creator_pack_sticker(v_id, true);
  select count(*) into v_public_count from app_private.list_public_creator_pack_for_channel('0000000c-0000-4000-8000-000000000403'::uuid) where display_name = 'Studio Crown';
  assert v_public_count = 1, 'an approved pack sticker must become viewer-visible immediately';
end
$$;

-- =========================================================================
-- Per-tier count limit: the next-item-over-limit case is rejected, not
-- silently truncated. Pro's limit is 10 — fill it, then prove #11 fails.
-- =========================================================================
do $$
declare i integer; v_outcome text;
begin
  perform set_config('app.user_id', '0000000a-0000-4000-8000-000000000401', true);
  -- one Pro upload already exists ("Pro Wave") from the block above.
  for i in 2..10 loop
    perform app_private.import_creator_pack_sticker('0000000c-0000-4000-8000-000000000401'::uuid, 'Pro Filler ' || i, 'Reaction', '\x7b2276223a22312e30222c226c6179657273223a5b5d7d'::bytea, false);
  end loop;

  if (select count(*) from public.creator_sticker_packs where channel_id = '0000000c-0000-4000-8000-000000000401'::uuid) <> 10 then
    assert false, 'expected exactly 10 pack stickers for the Pro channel before the boundary test';
  end if;

  begin
    perform app_private.import_creator_pack_sticker('0000000c-0000-4000-8000-000000000401'::uuid, 'One Too Many', 'Reaction', '\x7b2276223a22312e30222c226c6179657273223a5b5d7d'::bytea, false);
    assert false, 'the 11th pack sticker for a Pro-tier (limit 10) channel must be rejected';
  exception when others then
    assert sqlerrm like 'creator pack limit reached%', 'unexpected error: ' || sqlerrm;
  end;

  if (select count(*) from public.creator_sticker_packs where channel_id = '0000000c-0000-4000-8000-000000000401'::uuid) <> 10 then
    assert false, 'a rejected over-limit upload must not leave any row behind';
  end if;
end
$$;

-- =========================================================================
-- A non-owner/admin cannot upload to or manage another channel's pack.
-- =========================================================================
do $$
begin
  perform set_config('app.user_id', '0000000a-0000-4000-8000-000000000404', true);
  begin
    perform app_private.import_creator_pack_sticker('0000000c-0000-4000-8000-000000000401'::uuid, 'Intruder', 'Reaction', '\x7b2276223a22312e30222c226c6179657273223a5b5d7d'::bytea, false);
    assert false, 'a non-member must not be able to upload to another channel''s creator pack';
  exception when others then
    assert sqlerrm like 'not authorized%', 'unexpected error: ' || sqlerrm;
  end;
end
$$;

-- =========================================================================
-- Enable/disable takes effect immediately.
-- =========================================================================
do $$
declare v_id uuid; v_public_count integer;
begin
  perform set_config('app.user_id', '0000000a-0000-4000-8000-000000000401', true);
  select id into v_id from public.creator_sticker_packs where channel_id = '0000000c-0000-4000-8000-000000000401'::uuid and display_name = 'Pro Wave';

  perform app_private.set_creator_pack_sticker_enabled('0000000c-0000-4000-8000-000000000401'::uuid, v_id, false);
  select count(*) into v_public_count from app_private.list_public_creator_pack_for_channel('0000000c-0000-4000-8000-000000000401'::uuid) where display_name = 'Pro Wave';
  assert v_public_count = 0, 'disabling a pack sticker must remove it from the public listing immediately';

  perform app_private.set_creator_pack_sticker_enabled('0000000c-0000-4000-8000-000000000401'::uuid, v_id, true);
  select count(*) into v_public_count from app_private.list_public_creator_pack_for_channel('0000000c-0000-4000-8000-000000000401'::uuid) where display_name = 'Pro Wave';
  assert v_public_count = 1, 're-enabling a pack sticker must restore it to the public listing immediately';
end
$$;

-- =========================================================================
-- Attaching a creator-pack sticker to a tip. A viewer never supplies an
-- asset — only an id, re-validated server-side.
-- =========================================================================
insert into payment_accounts (id, channel_id, provider, environment, connected_account_ref, status, created_at, updated_at)
values ('0000000d-0000-4000-8000-000000000401', '0000000c-0000-4000-8000-000000000401'::uuid, 'razorpay', 'test', 'acct_l22b_fixture', 'active', current_timestamp, current_timestamp);

insert into payment_order_intents (
  id, channel_id, payment_account_id, provider, environment,
  connected_account_ref, idempotency_key, provider_receipt, provider_order_id,
  gross_amount_paise, currency, donor_display_name, donor_message, alert_consent,
  status, expires_at, created_at, updated_at
) values
  ('0000000e-0000-4000-8000-000000000401', '0000000c-0000-4000-8000-000000000401'::uuid, '0000000d-0000-4000-8000-000000000401'::uuid,
   'razorpay', 'test', 'acct_l22b_fixture', 'l22b-idempotency-paid-001', 'l22b-receipt-paid', 'order-l22b-paid', 5000, 'INR', '', '', true,
   'paid', current_timestamp + interval '10 minutes', current_timestamp, current_timestamp);

do $$
declare v_pack_id uuid; v_order_id uuid := '0000000e-0000-4000-8000-000000000401'::uuid; v_selection_id uuid;
begin
  select id into v_pack_id from public.creator_sticker_packs where channel_id = '0000000c-0000-4000-8000-000000000401'::uuid and display_name = 'Pro Wave';

  select app_private.attach_creator_pack_sticker_to_tip('0000000c-0000-4000-8000-000000000401'::uuid, v_order_id, v_pack_id) into v_selection_id;
  assert v_selection_id is not null, 'attaching a valid pack sticker to a paid order must succeed';

  begin
    perform app_private.attach_creator_pack_sticker_to_tip('0000000c-0000-4000-8000-000000000401'::uuid, v_order_id, v_pack_id);
    assert false, 'a second attach to the same order must be rejected';
  exception when others then
    assert sqlerrm like '%already attached%', 'unexpected error: ' || sqlerrm;
  end;
end
$$;

-- =========================================================================
-- Coexistence: a catalogue sticker and a creator-pack sticker can both be
-- attached to the SAME channel (different orders) without one shadowing
-- the other's listing or quota.
-- =========================================================================
do $$
declare v_catalogue_id uuid; v_pack_count integer; v_catalogue_count integer;
begin
  perform app_private.import_sticker_catalogue_entry('BSA-STK-PACKCOEXIST', 'Coexist Sticker', 'Celebration', 'pro', '\x7b2276223a22312e30222c226c6179657273223a5b5d7d'::bytea);

  perform set_config('app.user_id', '0000000a-0000-4000-8000-000000000401', true);
  select count(*) into v_catalogue_count from app_private.list_stickers_for_channel('0000000c-0000-4000-8000-000000000401'::uuid) where external_key = 'BSA-STK-PACKCOEXIST';
  assert v_catalogue_count = 1, 'the platform catalogue must remain visible alongside an active creator pack';

  select count(*) into v_pack_count from app_private.list_creator_pack_for_channel('0000000c-0000-4000-8000-000000000401'::uuid);
  assert v_pack_count = 10, 'the creator pack listing must be unaffected by the catalogue coexisting';
end
$$;

rollback;
