-- PRF-02 slice 7, §6 catalogue module #10 (QR Smart Card):
-- migration 0144's table and its four app_private functions.
--
-- Covers: the 1-120 destination/label bound (reused from 0109 line 67,
-- never a new number), owner/admin-only writes, upsert semantics (create
-- then update, is_enabled untouched by a destination/label change),
-- toggle semantics (not-found before a card exists, both directions
-- afterward), the creator read at every tier (§12.6 -- never tier-gate a
-- durable creator record), the overlay read's token-fingerprint/
-- revocation/expiry gate and its is_enabled predicate, cross-channel
-- isolation, and three structural assertions:
--   * no scene_id/visibility_rule/safe_zone column may ever exist on
--     public.qr_smart_cards (owner decision, 2026-09-17: "the module
--     must hold no scene concept at all");
--   * no scan/view/impression/exposure counter column may ever exist on
--     public.qr_smart_cards (same decision: "no scan counting, and no
--     claim about how many people scanned anything");
--   * list_overlay_qr_smart_card's OUT columns must be exactly
--     destination, label -- so a widened projection (an is_enabled flag,
--     a card id, a counter) is a failing test, not a silent change.
--
-- Uses base_world channel '...0011' (owner user '...0001', admin
-- '...0003', operator '...0004', moderator '...0005', viewer '...0006')
-- and '...0012' (owner user '...0002', the cross-channel probe). Own
-- fixture ids ...6600 upward -- a fresh block, well clear of every block
-- already recorded in fixtures/00_base_world.sql's ID ALLOCATION
-- REGISTRY (...0001-...1720, ...5500-...5aff) at the time this file was
-- written.
\set ON_ERROR_STOP on

insert into channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at)
values
  ('00000000-0000-4000-8000-000000000011', 1, 'free', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000000012', 1, 'studio', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp)
on conflict (channel_id, version) do nothing;

-- =========================================================================
-- STRUCTURAL: no scene concept, anywhere. Owner decision (reviews/
-- 2026-09-17-remaining-eight-modules-and-youtube-v1-amendment.md Part 1
-- §2): "the module must hold no scene concept at all -- nothing a future
-- CMP-17 could conflict with."
-- =========================================================================
do $$
declare offending text;
begin
  select string_agg(column_name, ', ') into offending
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'qr_smart_cards'
     and (column_name like '%scene%'
       or column_name like '%visibility_rule%'
       or column_name like '%safe_zone%');
  if offending is not null then
    raise exception 'public.qr_smart_cards must carry NO scene/visibility_rule/safe_zone column -- the module holds no scene concept at all (owner decision, 2026-09-17). Found: %', offending;
  end if;
end
$$;

-- =========================================================================
-- STRUCTURAL: no scan, view, impression or exposure counter, anywhere.
-- Same decision: "no scan counting, and no claim about how many people
-- scanned anything."
-- =========================================================================
do $$
declare offending text;
begin
  select string_agg(column_name, ', ') into offending
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'qr_smart_cards'
     and (column_name like '%scan%'
       or column_name like '%view_count%'
       or column_name like '%impression%'
       or column_name like '%exposure%'
       or column_name like '%count%');
  if offending is not null then
    raise exception 'public.qr_smart_cards must carry NO scan/view/impression/exposure/count column -- not authorised (owner decision, 2026-09-17). Found: %', offending;
  end if;
end
$$;

-- =========================================================================
-- STRUCTURAL: the overlay projection is exactly two columns, destination
-- and label -- no is_enabled, no id, no timestamp. Asserted against
-- information_schema.parameters so widening the projection fails here
-- instead of shipping silently.
-- =========================================================================
do $$
declare actual text;
begin
  select string_agg(p.parameter_name, ',' order by p.ordinal_position) into actual
    from information_schema.parameters p
    join information_schema.routines r
      on r.specific_name = p.specific_name and r.specific_schema = p.specific_schema
   where r.routine_schema = 'app_private'
     and r.routine_name = 'list_overlay_qr_smart_card'
     and p.parameter_mode = 'OUT';
  if actual is distinct from 'destination,label' then
    raise exception 'list_overlay_qr_smart_card must project exactly destination,label (no is_enabled, no id, no counter). Found: %', coalesce(actual, '<none>');
  end if;
end
$$;

-- =========================================================================
-- STRUCTURAL: RLS on, no direct table privilege to bsa_app, and every
-- function revoked from public and granted to bsa_app.
-- =========================================================================
do $$
declare rls boolean; direct_grants integer; fn record;
begin
  select relrowsecurity into rls from pg_class where oid = 'public.qr_smart_cards'::regclass;
  if not rls then raise exception 'public.qr_smart_cards must have row level security enabled'; end if;

  select count(*) into direct_grants
    from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'qr_smart_cards' and grantee = 'bsa_app';
  if direct_grants <> 0 then
    raise exception 'bsa_app must hold NO direct privilege on public.qr_smart_cards (all access is through security-definer functions); found % grant(s)', direct_grants;
  end if;

  for fn in
    select unnest(array[
      'app_private.upsert_qr_smart_card(uuid, text, text)',
      'app_private.set_qr_smart_card_enabled(uuid, boolean)',
      'app_private.list_channel_qr_smart_card(uuid)',
      'app_private.list_overlay_qr_smart_card(uuid, text)'
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
-- AUTHORISATION: only owner/admin may upsert. operator, moderator,
-- viewer and a non-member are each rejected (42501).
-- =========================================================================
do $$
declare probe record;
begin
  for probe in
    select unnest(array[
      '00000000-0000-4000-8000-000000000004',  -- operator
      '00000000-0000-4000-8000-000000000005',  -- moderator
      '00000000-0000-4000-8000-000000000006',  -- viewer
      '00000000-0000-4000-8000-000000000002'   -- non-member (channel 0012's owner)
    ]) as user_id
  loop
    perform set_config('app.user_id', probe.user_id, false);
    begin
      perform app_private.upsert_qr_smart_card('00000000-0000-4000-8000-000000000011'::uuid, 'https://example.com/should-not-be-created', 'Nope');
      raise exception 'upsert_qr_smart_card must reject user % -- only owner/admin may configure a channel''s card', probe.user_id;
    exception when insufficient_privilege then
      null;  -- expected
    end;
  end loop;
end
$$;

do $$
declare row_count integer;
begin
  select count(*) into row_count from public.qr_smart_cards;
  if row_count <> 0 then raise exception 'no card should exist after the rejected attempts, found %', row_count; end if;
end
$$;

-- =========================================================================
-- DESTINATION AND LABEL BOUND: exactly 1-120 each, reusing 0109 line
-- 67's decision.
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);

do $$
begin
  begin
    perform app_private.upsert_qr_smart_card('00000000-0000-4000-8000-000000000011'::uuid, '', 'Label');
    raise exception 'an empty destination must be rejected';
  exception when invalid_parameter_value then null;
  end;

  begin
    perform app_private.upsert_qr_smart_card('00000000-0000-4000-8000-000000000011'::uuid, repeat('a', 121), 'Label');
    raise exception 'a 121-character destination must be rejected -- the bound is 1-120 (migration 0109 line 67, reused)';
  exception when invalid_parameter_value then null;
  end;

  begin
    perform app_private.upsert_qr_smart_card('00000000-0000-4000-8000-000000000011'::uuid, null, 'Label');
    raise exception 'a null destination must be rejected';
  exception when invalid_parameter_value then null;
  end;

  begin
    perform app_private.upsert_qr_smart_card('00000000-0000-4000-8000-000000000011'::uuid, 'https://example.com/x', '');
    raise exception 'an empty label must be rejected';
  exception when invalid_parameter_value then null;
  end;

  begin
    perform app_private.upsert_qr_smart_card('00000000-0000-4000-8000-000000000011'::uuid, 'https://example.com/x', repeat('b', 121));
    raise exception 'a 121-character label must be rejected -- the bound is 1-120 (migration 0109 line 67, reused)';
  exception when invalid_parameter_value then null;
  end;

  begin
    perform app_private.upsert_qr_smart_card('00000000-0000-4000-8000-000000000011'::uuid, 'https://example.com/x', null);
    raise exception 'a null label must be rejected';
  exception when invalid_parameter_value then null;
  end;
end
$$;

do $$
declare row_count integer;
begin
  select count(*) into row_count from public.qr_smart_cards;
  if row_count <> 0 then raise exception 'no card should exist after the rejected bound violations, found %', row_count; end if;
end
$$;

-- The 120-character boundary value is accepted for both fields.
do $$
begin
  perform app_private.upsert_qr_smart_card('00000000-0000-4000-8000-000000000011'::uuid, repeat('a', 120), repeat('b', 120));
  if (select count(*) from public.qr_smart_cards where channel_id = '00000000-0000-4000-8000-000000000011') <> 1 then
    raise exception 'a 120-character destination and label must be accepted';
  end if;
end
$$;

-- =========================================================================
-- UPSERT SEMANTICS: creates with is_enabled = false; a later call
-- updates destination/label and leaves is_enabled untouched -- two
-- independent writes for two independent decisions (file header).
-- =========================================================================
do $$
declare v_enabled boolean;
begin
  select is_enabled into v_enabled from public.qr_smart_cards where channel_id = '00000000-0000-4000-8000-000000000011';
  if v_enabled is not false then raise exception 'a newly created card must default is_enabled to false, got %', v_enabled; end if;

  perform app_private.set_qr_smart_card_enabled('00000000-0000-4000-8000-000000000011'::uuid, true);

  perform app_private.upsert_qr_smart_card('00000000-0000-4000-8000-000000000011'::uuid, 'https://example.com/new-destination', 'New label');

  if (select destination from public.qr_smart_cards where channel_id = '00000000-0000-4000-8000-000000000011') <> 'https://example.com/new-destination' then
    raise exception 'a second upsert must update the destination';
  end if;
  if (select label from public.qr_smart_cards where channel_id = '00000000-0000-4000-8000-000000000011') <> 'New label' then
    raise exception 'a second upsert must update the label';
  end if;
  if (select is_enabled from public.qr_smart_cards where channel_id = '00000000-0000-4000-8000-000000000011') is not true then
    raise exception 'a destination/label upsert must NEVER change is_enabled -- it was toggled on and must stay on';
  end if;

  if (select count(*) from public.qr_smart_cards where channel_id = '00000000-0000-4000-8000-000000000011') <> 1 then
    raise exception 'channel_id is the primary key -- an upsert must never create a second row for the same channel';
  end if;
end
$$;

-- =========================================================================
-- TOGGLE SEMANTICS: not-found before a card exists (channel 0012, which
-- has never upserted one); both directions once one exists; only
-- owner/admin may toggle.
-- =========================================================================
do $$
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000002', false);
  begin
    perform app_private.set_qr_smart_card_enabled('00000000-0000-4000-8000-000000000012'::uuid, true);
    raise exception 'toggling a card that was never created must raise not-found, never implicitly create one';
  exception when no_data_found then null;
  end;
end
$$;

do $$
declare v_enabled boolean;
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);

  perform app_private.set_qr_smart_card_enabled('00000000-0000-4000-8000-000000000011'::uuid, false);
  select is_enabled into v_enabled from public.qr_smart_cards where channel_id = '00000000-0000-4000-8000-000000000011';
  if v_enabled is not false then raise exception 'toggling off must set is_enabled to false, got %', v_enabled; end if;

  perform app_private.set_qr_smart_card_enabled('00000000-0000-4000-8000-000000000011'::uuid, true);
  select is_enabled into v_enabled from public.qr_smart_cards where channel_id = '00000000-0000-4000-8000-000000000011';
  if v_enabled is not true then raise exception 'toggling on must set is_enabled to true, got %', v_enabled; end if;

  -- A destination/label untouched by either toggle.
  if (select destination from public.qr_smart_cards where channel_id = '00000000-0000-4000-8000-000000000011') <> 'https://example.com/new-destination' then
    raise exception 'toggling must never change the destination';
  end if;

  -- Only owner/admin may toggle.
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000006', false);  -- viewer
  begin
    perform app_private.set_qr_smart_card_enabled('00000000-0000-4000-8000-000000000011'::uuid, false);
    raise exception 'a viewer must not be able to toggle the card';
  exception when no_data_found then null;
  end;

  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);
  if (select is_enabled from public.qr_smart_cards where channel_id = '00000000-0000-4000-8000-000000000011') is not true then
    raise exception 'the rejected viewer toggle attempt must not have changed is_enabled';
  end if;
end
$$;

-- =========================================================================
-- CREATOR READ: available at EVERY tier (§12.6). Channel 0011 is `free`.
-- Visible to every channel member; zero rows to a non-member.
-- =========================================================================
do $$
declare probe record; row_count integer;
begin
  for probe in
    select unnest(array[
      '00000000-0000-4000-8000-000000000001',  -- owner
      '00000000-0000-4000-8000-000000000003',  -- admin
      '00000000-0000-4000-8000-000000000004',  -- operator
      '00000000-0000-4000-8000-000000000005',  -- moderator
      '00000000-0000-4000-8000-000000000006'   -- viewer
    ]) as user_id
  loop
    perform set_config('app.user_id', probe.user_id, false);
    select count(*) into row_count from app_private.list_channel_qr_smart_card('00000000-0000-4000-8000-000000000011'::uuid);
    if row_count <> 1 then
      raise exception 'member % must see the channel''s card on a FREE tier channel (§12.6), got % row(s)', probe.user_id, row_count;
    end if;
  end loop;

  -- A non-member sees nothing.
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000002', false);
  select count(*) into row_count from app_private.list_channel_qr_smart_card('00000000-0000-4000-8000-000000000011'::uuid);
  if row_count <> 0 then raise exception 'a non-member must see zero rows, got %', row_count; end if;
end
$$;

-- =========================================================================
-- OVERLAY READ: token-fingerprint gate, revocation, expiry,
-- cross-channel isolation, and the is_enabled predicate.
-- =========================================================================
insert into overlay_sessions (id, channel_id, token_fingerprint, expires_at, created_at)
values
  ('00000000-0000-4000-8000-000000006600', '00000000-0000-4000-8000-000000000011', 'prf02s7-overlay-fingerprint', current_timestamp + interval '1 hour', current_timestamp),
  ('00000000-0000-4000-8000-000000006601', '00000000-0000-4000-8000-000000000012', 'prf02s7-other-channel-fingerprint', current_timestamp + interval '1 hour', current_timestamp),
  ('00000000-0000-4000-8000-000000006602', '00000000-0000-4000-8000-000000000011', 'prf02s7-expired-fingerprint', current_timestamp - interval '1 minute', current_timestamp),
  ('00000000-0000-4000-8000-000000006603', '00000000-0000-4000-8000-000000000011', 'prf02s7-revoked-fingerprint', current_timestamp + interval '1 hour', current_timestamp);

update overlay_sessions set revoked_at = current_timestamp where id = '00000000-0000-4000-8000-000000006603';

do $$
declare v_destination text; v_label text; row_count integer;
begin
  -- The happy path: is_enabled is true (set above), so exactly one row.
  select count(*) into row_count from app_private.list_overlay_qr_smart_card('00000000-0000-4000-8000-000000006600'::uuid, 'prf02s7-overlay-fingerprint');
  if row_count <> 1 then raise exception 'the overlay read must return exactly the one enabled card, got % row(s)', row_count; end if;

  select destination, label into v_destination, v_label from app_private.list_overlay_qr_smart_card('00000000-0000-4000-8000-000000006600'::uuid, 'prf02s7-overlay-fingerprint');
  if v_destination <> 'https://example.com/new-destination' then raise exception 'the overlay read must return the current destination, got %', v_destination; end if;
  if v_label <> 'New label' then raise exception 'the overlay read must return the current label, got %', v_label; end if;

  -- A wrong fingerprint, an expired session and a revoked session each
  -- return zero rows.
  select count(*) into row_count from app_private.list_overlay_qr_smart_card('00000000-0000-4000-8000-000000006600'::uuid, 'wrong-fingerprint');
  if row_count <> 0 then raise exception 'a wrong token fingerprint must return zero rows, got %', row_count; end if;

  select count(*) into row_count from app_private.list_overlay_qr_smart_card('00000000-0000-4000-8000-000000006602'::uuid, 'prf02s7-expired-fingerprint');
  if row_count <> 0 then raise exception 'an expired overlay session must return zero rows, got %', row_count; end if;

  select count(*) into row_count from app_private.list_overlay_qr_smart_card('00000000-0000-4000-8000-000000006603'::uuid, 'prf02s7-revoked-fingerprint');
  if row_count <> 0 then raise exception 'a revoked overlay session must return zero rows, got %', row_count; end if;

  -- Cross-channel isolation: channel 0012's overlay never sees 0011's
  -- card (0012 has none of its own).
  select count(*) into row_count from app_private.list_overlay_qr_smart_card('00000000-0000-4000-8000-000000006601'::uuid, 'prf02s7-other-channel-fingerprint');
  if row_count <> 0 then raise exception 'another channel''s overlay session must never see this channel''s card, got % row(s)', row_count; end if;
end
$$;

-- Turning the toggle off makes the overlay read return zero rows on the
-- very next call -- the card simply has nothing to show. The row itself
-- (destination/label) is never deleted (§12.6's durable creator record).
--
-- The CREATOR READ block above left app.user_id set to the non-member
-- probe (...0002); reset to channel 0011's owner before writing again.
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);

do $$
declare row_count integer;
begin
  perform app_private.set_qr_smart_card_enabled('00000000-0000-4000-8000-000000000011'::uuid, false);

  select count(*) into row_count from app_private.list_overlay_qr_smart_card('00000000-0000-4000-8000-000000006600'::uuid, 'prf02s7-overlay-fingerprint');
  if row_count <> 0 then raise exception 'after the creator disables the card, the overlay read must return zero rows, got %', row_count; end if;

  -- And the creator read still shows the (now disabled) card, unchanged.
  select count(*) into row_count from app_private.list_channel_qr_smart_card('00000000-0000-4000-8000-000000000011'::uuid);
  if row_count <> 1 then raise exception 'after disabling, the creator read must still show the card (§12.6 -- it is not deleted), got % row(s)', row_count; end if;
end
$$;

-- A studio-tier channel behaves identically to the free-tier one: the
-- tier is never read by any of these functions (decision 4 in the file
-- header -- one gate only, and it is §30.3's render cap in 0131, not
-- anything here).
do $$
declare row_count integer;
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000002', false);
  perform app_private.upsert_qr_smart_card('00000000-0000-4000-8000-000000000012'::uuid, 'https://example.com/studio-tier', 'Studio tier card');
  perform app_private.set_qr_smart_card_enabled('00000000-0000-4000-8000-000000000012'::uuid, true);

  select count(*) into row_count from app_private.list_channel_qr_smart_card('00000000-0000-4000-8000-000000000012'::uuid);
  if row_count <> 1 then raise exception 'a studio-tier channel must read its own card exactly as a free-tier one does, got % row(s)', row_count; end if;

  select count(*) into row_count from app_private.list_overlay_qr_smart_card('00000000-0000-4000-8000-000000006601'::uuid, 'prf02s7-other-channel-fingerprint');
  if row_count <> 1 then raise exception 'channel 0012''s own overlay session must now see channel 0012''s own enabled card, got % row(s)', row_count; end if;
end
$$;
