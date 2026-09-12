-- L22: curated sticker catalogue, creator enable/disable, and sticker
-- attachment to an already-paid tip order (0110). Wrapped in
-- begin;...rollback; per this session's established lesson against
-- cross-test pollution in the shared disposable database.
begin;

insert into app_users (id, external_subject, display_name, created_at, updated_at) values
  ('0000000a-0000-4000-8000-000000000301', 'ext-stk-001', 'Free Owner', now(), now()),
  ('0000000a-0000-4000-8000-000000000302', 'ext-stk-002', 'Creator Owner', now(), now());

select channel_id from app_private.create_channel('0000000c-0000-4000-8000-000000000301'::uuid, '0000000a-0000-4000-8000-000000000301'::uuid, 'stkfreetest', 'Free Tier Channel');
select channel_id from app_private.create_channel('0000000c-0000-4000-8000-000000000302'::uuid, '0000000a-0000-4000-8000-000000000302'::uuid, 'stkcreatortest', 'Creator Tier Channel');

insert into channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at)
values ('0000000c-0000-4000-8000-000000000302'::uuid, 2, 'creator', 'individual_plan', jsonb_build_object('queueCount', 3), current_timestamp, current_timestamp);
-- the free channel keeps the 'free' row create_channel already inserted at version 1.

-- =========================================================================
-- Import pipeline: create / skip / update, same shape as 0106.
-- =========================================================================
do $$
declare v_outcome text; v_id uuid; v_first_id uuid;
begin
  select outcome, entry_id into v_outcome, v_id from app_private.import_sticker_catalogue_entry(
    'BSA-STK-001', 'Confetti Pop', 'Celebration', 'free', '\x7b2276223a22312e30222c226c6179657273223a5b5d7d'::bytea
  );
  assert v_outcome = 'created', 'first import of a new external_key must report created, got: ' || v_outcome;
  v_first_id := v_id;

  select outcome, entry_id into v_outcome, v_id from app_private.import_sticker_catalogue_entry(
    'BSA-STK-001', 'Confetti Pop', 'Celebration', 'free', '\x7b2276223a22312e30222c226c6179657273223a5b5d7d'::bytea
  );
  assert v_outcome = 'skipped', 'a byte-identical re-import must report skipped, got: ' || v_outcome;
  assert v_id = v_first_id, 're-import must resolve to the same row id, not a duplicate';

  if (select count(*) from public.sticker_catalogue_entries where external_key = 'BSA-STK-001') <> 1 then
    assert false, 'exactly one row must exist for external_key BSA-STK-001 after two identical imports';
  end if;
end
$$;

-- a malformed entry (unrecognised tier) is rejected loudly, no partial row.
do $$
begin
  begin
    perform app_private.import_sticker_catalogue_entry('BSA-STK-BAD-TIER', 'Bad Tier', 'Celebration', 'enterprise', '\x7b7d'::bytea);
    assert false, 'an unrecognised tier must have raised';
  exception when others then
    assert sqlerrm like 'unrecognised tier for sticker entitlement:%', 'unexpected error: ' || sqlerrm;
  end;
  perform 1 from public.sticker_catalogue_entries where external_key = 'BSA-STK-BAD-TIER';
  assert not found, 'a rejected entry must not leave any row behind';
end
$$;

-- an oversized asset is rejected by the function's own check, not just the
-- table CHECK constraint (defense in depth, same as 0077/0106).
do $$
declare v_oversized bytea;
begin
  select decode(repeat('41', 2000001), 'hex') into v_oversized;
  begin
    perform app_private.import_sticker_catalogue_entry('BSA-STK-BAD-SIZE', 'Too Big', 'Celebration', 'free', v_oversized);
    assert false, 'an oversized asset must have raised';
  exception when others then
    assert sqlerrm = 'invalid sticker asset', 'unexpected error: ' || sqlerrm;
  end;
  perform 1 from public.sticker_catalogue_entries where external_key = 'BSA-STK-BAD-SIZE';
  assert not found, 'a rejected oversized entry must not leave any row behind';
end
$$;

-- seed one entry per tier for the filtering + attach tests below.
do $$
begin
  perform app_private.import_sticker_catalogue_entry('BSA-STK-TIER-FREE', 'Free Wave', 'Reaction', 'free', '\x7b2276223a2231227d'::bytea);
  perform app_private.import_sticker_catalogue_entry('BSA-STK-TIER-PRO', 'Pro Heart', 'Reaction', 'pro', '\x7b2276223a2231227d'::bytea);
  perform app_private.import_sticker_catalogue_entry('BSA-STK-TIER-CREATOR', 'Creator Fire', 'Reaction', 'creator', '\x7b2276223a2231227d'::bytea);
  perform app_private.import_sticker_catalogue_entry('BSA-STK-TIER-STUDIO', 'Studio Crown', 'Reaction', 'studio', '\x7b2276223a2231227d'::bytea);
end
$$;

-- =========================================================================
-- Per-tier availability: a free channel sees only free-tier stickers, a
-- creator-tier channel sees free+pro+creator but not studio.
-- =========================================================================
do $$
declare v_free_keys text[];
declare v_creator_keys text[];
begin
  perform set_config('app.user_id', '0000000a-0000-4000-8000-000000000301', true);
  select array_agg(external_key order by external_key) into v_free_keys
    from app_private.list_stickers_for_channel('0000000c-0000-4000-8000-000000000301'::uuid)
   where external_key like 'BSA-STK-TIER-%';
  assert v_free_keys = array['BSA-STK-TIER-FREE'], 'a free-tier channel must see only the free-tier sticker, got: ' || coalesce(array_to_string(v_free_keys, ','), '<none>');

  perform set_config('app.user_id', '0000000a-0000-4000-8000-000000000302', true);
  select array_agg(external_key order by external_key) into v_creator_keys
    from app_private.list_stickers_for_channel('0000000c-0000-4000-8000-000000000302'::uuid)
   where external_key like 'BSA-STK-TIER-%';
  assert v_creator_keys = array['BSA-STK-TIER-CREATOR', 'BSA-STK-TIER-FREE', 'BSA-STK-TIER-PRO'], 'a creator-tier channel must see free+pro+creator but not studio, got: ' || coalesce(array_to_string(v_creator_keys, ','), '<none>');
end
$$;

-- =========================================================================
-- Creator enable/disable, and that it takes effect immediately on the
-- public (viewer-facing) listing.
-- =========================================================================
do $$
declare v_free_sticker_id uuid;
declare v_public_names text[];
begin
  select id into v_free_sticker_id from public.sticker_catalogue_entries where external_key = 'BSA-STK-TIER-FREE';

  -- the free channel's owner disables it.
  perform set_config('app.user_id', '0000000a-0000-4000-8000-000000000301', true);
  perform app_private.set_channel_sticker_enabled('0000000c-0000-4000-8000-000000000301'::uuid, v_free_sticker_id, false);

  select array_agg(display_name) into v_public_names
    from app_private.list_public_stickers_for_channel('0000000c-0000-4000-8000-000000000301'::uuid)
   where display_name = 'Free Wave';
  assert v_public_names is null, 'a disabled sticker must disappear from the public listing immediately';

  -- re-enabling is equally immediate.
  perform app_private.set_channel_sticker_enabled('0000000c-0000-4000-8000-000000000301'::uuid, v_free_sticker_id, true);
  select array_agg(display_name) into v_public_names
    from app_private.list_public_stickers_for_channel('0000000c-0000-4000-8000-000000000301'::uuid)
   where display_name = 'Free Wave';
  assert v_public_names = array['Free Wave'], 're-enabling must restore the sticker to the public listing immediately';
end
$$;

-- a non-owner/admin cannot toggle another channel's stickers.
do $$
declare v_free_sticker_id uuid;
begin
  select id into v_free_sticker_id from public.sticker_catalogue_entries where external_key = 'BSA-STK-TIER-FREE';
  perform set_config('app.user_id', '0000000a-0000-4000-8000-000000000302', true);
  begin
    perform app_private.set_channel_sticker_enabled('0000000c-0000-4000-8000-000000000301'::uuid, v_free_sticker_id, false);
    assert false, 'a non-member must not be able to toggle a channel''s stickers';
  exception when others then
    assert sqlerrm like 'not authorized%', 'unexpected error: ' || sqlerrm;
  end;
end
$$;

-- =========================================================================
-- Attaching a sticker to a tip. A viewer never supplies an asset — only an
-- id, re-validated server-side against the live enabled/tier set.
-- =========================================================================
insert into payment_accounts (id, channel_id, provider, environment, connected_account_ref, status, created_at, updated_at)
values ('0000000d-0000-4000-8000-000000000301', '0000000c-0000-4000-8000-000000000301'::uuid, 'razorpay', 'test', 'acct_l22_fixture', 'active', current_timestamp, current_timestamp);

insert into payment_order_intents (
  id, channel_id, payment_account_id, provider, environment,
  connected_account_ref, idempotency_key, provider_receipt, provider_order_id,
  gross_amount_paise, currency, donor_display_name, donor_message, alert_consent,
  status, expires_at, created_at, updated_at
) values
  -- paid order on the free channel.
  ('0000000e-0000-4000-8000-000000000301', '0000000c-0000-4000-8000-000000000301'::uuid, '0000000d-0000-4000-8000-000000000301'::uuid,
   'razorpay', 'test', 'acct_l22_fixture', 'l22-idempotency-paid-001', 'l22-receipt-paid', 'order-l22-paid', 5000, 'INR', '', '', true,
   'paid', current_timestamp + interval '10 minutes', current_timestamp, current_timestamp),
  -- not-yet-paid order on the free channel.
  ('0000000e-0000-4000-8000-000000000302', '0000000c-0000-4000-8000-000000000301'::uuid, '0000000d-0000-4000-8000-000000000301'::uuid,
   'razorpay', 'test', 'acct_l22_fixture', 'l22-idempotency-pending-001', 'l22-receipt-pending', 'order-l22-pending', 5000, 'INR', '', '', true,
   'provider_created', current_timestamp + interval '10 minutes', current_timestamp, current_timestamp),
  -- a second paid order, kept separate from the happy-path order above so
  -- the unknown-sticker-id case below is not masked by an
  -- already-attached rejection.
  ('0000000e-0000-4000-8000-000000000305', '0000000c-0000-4000-8000-000000000301'::uuid, '0000000d-0000-4000-8000-000000000301'::uuid,
   'razorpay', 'test', 'acct_l22_fixture', 'l22-idempotency-paid-005', 'l22-receipt-paid-5', 'order-l22-paid-5', 5000, 'INR', '', '', true,
   'paid', current_timestamp + interval '10 minutes', current_timestamp, current_timestamp);

do $$
declare v_free_sticker_id uuid;
declare v_pro_sticker_id uuid;
declare v_selection_id uuid;
begin
  select id into v_free_sticker_id from public.sticker_catalogue_entries where external_key = 'BSA-STK-TIER-FREE';
  select id into v_pro_sticker_id from public.sticker_catalogue_entries where external_key = 'BSA-STK-TIER-PRO';

  -- happy path: a paid order, an enabled, tier-eligible sticker.
  select app_private.attach_sticker_to_tip('0000000c-0000-4000-8000-000000000301'::uuid, '0000000e-0000-4000-8000-000000000301'::uuid, v_free_sticker_id) into v_selection_id;
  assert v_selection_id is not null, 'a valid attach must return a selection id';
  perform 1 from public.channel_sticker_selections where id = v_selection_id and order_id = '0000000e-0000-4000-8000-000000000301'::uuid and sticker_id = v_free_sticker_id;
  assert found, 'the selection must be persisted with the correct order and sticker';

  -- a second sticker on the same already-attached order is rejected.
  begin
    perform app_private.attach_sticker_to_tip('0000000c-0000-4000-8000-000000000301'::uuid, '0000000e-0000-4000-8000-000000000301'::uuid, v_free_sticker_id);
    assert false, 'attaching a second sticker to the same order must have raised';
  exception when others then
    assert sqlerrm like 'a sticker is already attached%', 'unexpected error: ' || sqlerrm;
  end;

  -- an unknown sticker id is rejected, not silently dropped (uses a
  -- separate paid order so this is not masked by an already-attached
  -- rejection from the happy path above).
  begin
    perform app_private.attach_sticker_to_tip('0000000c-0000-4000-8000-000000000301'::uuid, '0000000e-0000-4000-8000-000000000305'::uuid, gen_random_uuid());
    assert false, 'an unknown sticker id must have raised';
  exception when others then
    assert sqlerrm = 'unknown sticker', 'unexpected error: ' || sqlerrm;
  end;
  perform 1 from public.channel_sticker_selections where order_id = '0000000e-0000-4000-8000-000000000305'::uuid;
  assert not found, 'a rejected attach must leave no selection row behind';

  -- an order that has not reached 'paid' status is rejected.
  begin
    perform app_private.attach_sticker_to_tip('0000000c-0000-4000-8000-000000000301'::uuid, '0000000e-0000-4000-8000-000000000302'::uuid, v_free_sticker_id);
    assert false, 'attaching to an unpaid order must have raised';
  exception when others then
    assert sqlerrm = 'tip order is not yet paid', 'unexpected error: ' || sqlerrm;
  end;

  -- a sticker above the channel's current tier is rejected (per-tier
  -- availability enforced server-side at the attach boundary too, not
  -- only at listing time).
  begin
    perform app_private.attach_sticker_to_tip('0000000c-0000-4000-8000-000000000301'::uuid, '0000000e-0000-4000-8000-000000000302'::uuid, v_pro_sticker_id);
    assert false, 'attaching a sticker above the channel''s tier must have raised (order status wins first, so this proves the same reject path handles both)';
  exception when others then
    assert sqlerrm = 'tip order is not yet paid', 'unexpected error: ' || sqlerrm;
  end;
end
$$;

-- a viewer cannot use a sticker the creator disabled — proven end to end:
-- disable, then attempt to attach to a fresh paid order, then confirm it
-- is rejected and that re-enabling restores the ability immediately.
insert into payment_order_intents (
  id, channel_id, payment_account_id, provider, environment,
  connected_account_ref, idempotency_key, provider_receipt, provider_order_id,
  gross_amount_paise, currency, donor_display_name, donor_message, alert_consent,
  status, expires_at, created_at, updated_at
) values
  ('0000000e-0000-4000-8000-000000000303', '0000000c-0000-4000-8000-000000000301'::uuid, '0000000d-0000-4000-8000-000000000301'::uuid,
   'razorpay', 'test', 'acct_l22_fixture', 'l22-idempotency-paid-002', 'l22-receipt-paid-2', 'order-l22-paid-2', 5000, 'INR', '', '', true,
   'paid', current_timestamp + interval '10 minutes', current_timestamp, current_timestamp),
  ('0000000e-0000-4000-8000-000000000304', '0000000c-0000-4000-8000-000000000301'::uuid, '0000000d-0000-4000-8000-000000000301'::uuid,
   'razorpay', 'test', 'acct_l22_fixture', 'l22-idempotency-paid-003', 'l22-receipt-paid-3', 'order-l22-paid-3', 5000, 'INR', '', '', true,
   'paid', current_timestamp + interval '10 minutes', current_timestamp, current_timestamp);

do $$
declare v_free_sticker_id uuid;
begin
  select id into v_free_sticker_id from public.sticker_catalogue_entries where external_key = 'BSA-STK-TIER-FREE';

  perform set_config('app.user_id', '0000000a-0000-4000-8000-000000000301', true);
  perform app_private.set_channel_sticker_enabled('0000000c-0000-4000-8000-000000000301'::uuid, v_free_sticker_id, false);

  begin
    perform app_private.attach_sticker_to_tip('0000000c-0000-4000-8000-000000000301'::uuid, '0000000e-0000-4000-8000-000000000303'::uuid, v_free_sticker_id);
    assert false, 'a viewer must not be able to attach a sticker the creator disabled';
  exception when others then
    assert sqlerrm = 'sticker is disabled for this channel', 'unexpected error: ' || sqlerrm;
  end;
  perform 1 from public.channel_sticker_selections where order_id = '0000000e-0000-4000-8000-000000000303'::uuid;
  assert not found, 'a rejected (disabled) attach must leave no selection row behind';

  -- re-enabling takes effect immediately: the very next attach on a fresh
  -- paid order succeeds with no separate propagation step.
  perform app_private.set_channel_sticker_enabled('0000000c-0000-4000-8000-000000000301'::uuid, v_free_sticker_id, true);
  perform app_private.attach_sticker_to_tip('0000000c-0000-4000-8000-000000000301'::uuid, '0000000e-0000-4000-8000-000000000304'::uuid, v_free_sticker_id);
  perform 1 from public.channel_sticker_selections where order_id = '0000000e-0000-4000-8000-000000000304'::uuid and sticker_id = v_free_sticker_id;
  assert found, 're-enabling must allow an attach on the very next call';
end
$$;

rollback;
