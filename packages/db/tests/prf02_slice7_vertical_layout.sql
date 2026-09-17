-- PRF-02 slice 7, §6 module #14 (Vertical Stream Layout):
-- migration 0147's public.channels.canvas_layout column and its five
-- app_private functions, plus the dead-key retirement 0147 makes to
-- 0131's master_canvas_modules check constraint.
--
-- Covers:
--   * a layout is NOT a module -- setting it creates no
--     master_canvas_modules row and consumes no §30.3 cap slot;
--   * the four retired keys ('now_playing', 'chat',
--     'stream_health_widget', 'vertical_stream_layout') are rejected by
--     the tightened check constraint;
--   * storing the preference is never tier-gated (§12.6): a Free
--     channel can configure 'vertical' and see it recorded;
--   * the Pro+ render gate lives ONLY inside
--     app_private.list_overlay_canvas_layout -- a sub-Pro channel that
--     configured 'vertical' gets a valid token back with layout =
--     'horizontal', never an error and never zero rows for that reason;
--   * upgrading the same channel to Pro flips the overlay projection to
--     'vertical' live, with no second write;
--   * owner/admin-only writes; every member role can read; a
--     non-member sees zero rows;
--   * invalid layout values (not 'horizontal'/'vertical') rejected;
--   * the overlay read's token-fingerprint/revocation/expiry gate,
--     cross-channel isolation, and always-exactly-one-row-for-a-valid-
--     session behaviour (unlike a module read, there is no "nothing to
--     paint" state for a layout);
--   * the returned column set of list_overlay_canvas_layout is exactly
--     `layout` -- a widened projection is a failing test, not a silent
--     change;
--   * an unrecognised tier fails closed (raises), matching every other
--     *_tier_rank helper's posture.
--
-- Uses base_world channel '...0011' (owner user '...0001', admin
-- '...0003', operator '...0004', moderator '...0005', viewer '...0006')
-- and '...0012' (owner user '...0002', the cross-channel/upgrade probe).
-- Own fixture ids ...5e00 upward -- see fixtures/00_base_world.sql's ID
-- ALLOCATION REGISTRY, verified free before use.
\set ON_ERROR_STOP on

insert into channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at)
values
  ('00000000-0000-4000-8000-000000000011', 1, 'free', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000000012', 1, 'free', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp)
on conflict (channel_id, version) do nothing;

-- =========================================================================
-- 1. A LAYOUT IS NOT A MODULE: the four keys 0147 retired from 0131's
--    check constraint are rejected outright, and setting a channel's
--    canvas_layout creates no master_canvas_modules row at all.
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);

do $$
declare dead_key text;
begin
  foreach dead_key in array array['now_playing', 'chat', 'stream_health_widget', 'vertical_stream_layout']
  loop
    begin
      perform app_private.upsert_master_canvas_module('00000000-0000-4000-8000-000000000011'::uuid, dead_key, true);
      raise exception 'retired module_key % must be rejected by the tightened check constraint (migration 0147)', dead_key;
    exception when check_violation then
      null; -- expected
    end;
  end loop;
end
$$;

do $$
declare row_count integer;
begin
  select count(*) into row_count from public.master_canvas_modules where channel_id = '00000000-0000-4000-8000-000000000011';
  if row_count <> 0 then raise exception 'no master_canvas_modules row should exist after the rejected dead-key attempts, found %', row_count; end if;
end
$$;

-- =========================================================================
-- STRUCTURAL: list_overlay_canvas_layout's OUT columns are exactly
-- `layout` -- no channel_id, no entitled flag, no timestamp.
-- =========================================================================
do $$
declare actual text;
begin
  select string_agg(p.parameter_name, ',' order by p.ordinal_position) into actual
    from information_schema.parameters p
    join information_schema.routines r
      on r.specific_name = p.specific_name and r.specific_schema = p.specific_schema
   where r.routine_schema = 'app_private'
     and r.routine_name = 'list_overlay_canvas_layout'
     and p.parameter_mode = 'OUT';
  if actual is distinct from 'layout' then
    raise exception 'list_overlay_canvas_layout must project exactly layout. Found: %', coalesce(actual, '<none>');
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
   where r.routine_schema = 'app_private'
     and r.routine_name = 'get_channel_canvas_layout'
     and p.parameter_mode = 'OUT';
  if actual is distinct from 'layout,vertical_entitled' then
    raise exception 'get_channel_canvas_layout must project exactly layout,vertical_entitled. Found: %', coalesce(actual, '<none>');
  end if;
end
$$;

-- =========================================================================
-- STRUCTURAL: every function revoked from public, granted to bsa_app.
-- =========================================================================
do $$
declare fn record;
begin
  for fn in
    select unnest(array[
      'app_private.canvas_layout_tier_rank(text)',
      'app_private.vertical_canvas_layout_entitled(uuid)',
      'app_private.set_channel_canvas_layout(uuid, uuid, text)',
      'app_private.get_channel_canvas_layout(uuid)',
      'app_private.list_overlay_canvas_layout(uuid, text)'
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
-- 2. DEFAULT: a channel that never called set_channel_canvas_layout
--    reads 'horizontal'.
-- =========================================================================
do $$
declare v_layout text; v_entitled boolean;
begin
  select layout, vertical_entitled into v_layout, v_entitled from app_private.get_channel_canvas_layout('00000000-0000-4000-8000-000000000011'::uuid);
  if v_layout <> 'horizontal' then raise exception 'a channel that never configured a layout must read horizontal by default, got %', v_layout; end if;
  if v_entitled is not false then raise exception 'a free-tier channel must not be vertical-entitled, got %', v_entitled; end if;
end
$$;

-- =========================================================================
-- 3. AUTHORISATION: only owner/admin may set. operator, moderator,
--    viewer and a non-member are each rejected (42501); the row is
--    unaffected.
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
      perform app_private.set_channel_canvas_layout('00000000-0000-4000-8000-000000000011'::uuid, probe.user_id::uuid, 'vertical');
      raise exception 'set_channel_canvas_layout must reject user % -- only owner/admin may configure a channel''s canvas layout', probe.user_id;
    exception when insufficient_privilege then
      null; -- expected
    end;
  end loop;
end
$$;

do $$
declare v_layout text;
begin
  select layout into v_layout from app_private.get_channel_canvas_layout('00000000-0000-4000-8000-000000000011'::uuid);
  if v_layout <> 'horizontal' then raise exception 'no rejected attempt may have changed the layout, got %', v_layout; end if;
end
$$;

-- =========================================================================
-- 4. INVALID LAYOUT VALUES REJECTED.
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);

do $$
begin
  begin
    perform app_private.set_channel_canvas_layout('00000000-0000-4000-8000-000000000011'::uuid, '00000000-0000-4000-8000-000000000001'::uuid, 'square');
    raise exception 'an unrecognised layout value must be rejected';
  exception when invalid_parameter_value then null;
  end;

  begin
    perform app_private.set_channel_canvas_layout('00000000-0000-4000-8000-000000000011'::uuid, '00000000-0000-4000-8000-000000000001'::uuid, null);
    raise exception 'a null layout value must be rejected';
  exception when invalid_parameter_value then null;
  end;
end
$$;

-- =========================================================================
-- 5. STORING IS NEVER TIER-GATED (§12.6): the FREE-tier channel 0011 can
--    configure 'vertical' and it is recorded -- and creates no
--    master_canvas_modules row (section 1's proof, reconfirmed after a
--    real write).
-- =========================================================================
do $$
declare v_layout text; row_count integer;
begin
  perform app_private.set_channel_canvas_layout('00000000-0000-4000-8000-000000000011'::uuid, '00000000-0000-4000-8000-000000000001'::uuid, 'vertical');
  select layout into v_layout from app_private.get_channel_canvas_layout('00000000-0000-4000-8000-000000000011'::uuid);
  if v_layout <> 'vertical' then raise exception 'a free-tier channel must be able to configure vertical (§12.6), got %', v_layout; end if;

  select count(*) into row_count from public.master_canvas_modules where channel_id = '00000000-0000-4000-8000-000000000011';
  if row_count <> 0 then raise exception 'configuring canvas_layout must never create a master_canvas_modules row -- a layout is not a module, found % row(s)', row_count; end if;
end
$$;

-- =========================================================================
-- 6. THE SUB-PRO CHANNEL PROOF: a valid overlay token for the FREE-tier
--    channel 0011, now configured 'vertical', receives 'horizontal' --
--    not an error, not zero rows.
-- =========================================================================
insert into overlay_sessions (id, channel_id, token_fingerprint, expires_at, created_at)
values
  ('00000000-0000-4000-8000-000000005e01', '00000000-0000-4000-8000-000000000011', 'prf02s7vl-overlay-fingerprint', current_timestamp + interval '1 hour', current_timestamp),
  ('00000000-0000-4000-8000-000000005e02', '00000000-0000-4000-8000-000000000012', 'prf02s7vl-other-channel-fingerprint', current_timestamp + interval '1 hour', current_timestamp),
  ('00000000-0000-4000-8000-000000005e03', '00000000-0000-4000-8000-000000000011', 'prf02s7vl-expired-fingerprint', current_timestamp - interval '1 minute', current_timestamp),
  ('00000000-0000-4000-8000-000000005e04', '00000000-0000-4000-8000-000000000011', 'prf02s7vl-revoked-fingerprint', current_timestamp + interval '1 hour', current_timestamp);

update overlay_sessions set revoked_at = current_timestamp where id = '00000000-0000-4000-8000-000000005e04';

do $$
declare v_layout text; row_count integer;
begin
  select count(*) into row_count from app_private.list_overlay_canvas_layout('00000000-0000-4000-8000-000000005e01'::uuid, 'prf02s7vl-overlay-fingerprint');
  if row_count <> 1 then raise exception 'a valid overlay session must always return exactly one layout row, got %', row_count; end if;

  select layout into v_layout from app_private.list_overlay_canvas_layout('00000000-0000-4000-8000-000000005e01'::uuid, 'prf02s7vl-overlay-fingerprint');
  if v_layout <> 'horizontal' then
    raise exception 'PRF-02 slice 7 CORRECTION: a sub-Pro (free-tier) channel configured vertical must receive layout=horizontal from the overlay read, not an error -- got %', v_layout;
  end if;
end
$$;

-- =========================================================================
-- 7. UPGRADE PROOF: retiering the SAME channel to Pro flips the overlay
--    projection to 'vertical' live, with no second write to
--    canvas_layout.
-- =========================================================================
update channel_entitlement_versions set tier = 'pro' where channel_id = '00000000-0000-4000-8000-000000000011';

do $$
declare v_layout text;
begin
  select layout into v_layout from app_private.list_overlay_canvas_layout('00000000-0000-4000-8000-000000005e01'::uuid, 'prf02s7vl-overlay-fingerprint');
  if v_layout <> 'vertical' then
    raise exception 'a Pro-tier channel configured vertical must receive layout=vertical from the overlay read, got %', v_layout;
  end if;
end
$$;

do $$
declare v_entitled boolean;
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);
  select vertical_entitled into v_entitled from app_private.get_channel_canvas_layout('00000000-0000-4000-8000-000000000011'::uuid);
  if v_entitled is not true then raise exception 'a Pro-tier channel must read vertical_entitled = true, got %', v_entitled; end if;
end
$$;

-- Switching back to 'horizontal' explicitly is honoured even though the
-- channel is now entitled -- the creator's own choice, not implied by
-- entitlement.
do $$
declare v_layout text;
begin
  perform app_private.set_channel_canvas_layout('00000000-0000-4000-8000-000000000011'::uuid, '00000000-0000-4000-8000-000000000001'::uuid, 'horizontal');
  select layout into v_layout from app_private.list_overlay_canvas_layout('00000000-0000-4000-8000-000000005e01'::uuid, 'prf02s7vl-overlay-fingerprint');
  if v_layout <> 'horizontal' then raise exception 'an explicit horizontal choice on a Pro-entitled channel must still read horizontal, got %', v_layout; end if;

  -- Restore vertical for the remaining overlay-gate tests below.
  perform app_private.set_channel_canvas_layout('00000000-0000-4000-8000-000000000011'::uuid, '00000000-0000-4000-8000-000000000001'::uuid, 'vertical');
end
$$;

-- =========================================================================
-- 8. OVERLAY SESSION GATING: wrong fingerprint, expired session and
--    revoked session each return ZERO rows -- unlike the tier gate
--    above, an invalid SESSION is never papered over with a default.
-- =========================================================================
do $$
declare row_count integer;
begin
  select count(*) into row_count from app_private.list_overlay_canvas_layout('00000000-0000-4000-8000-000000005e01'::uuid, 'wrong-fingerprint-entirely');
  if row_count <> 0 then raise exception 'a wrong token fingerprint must return zero rows, got %', row_count; end if;

  select count(*) into row_count from app_private.list_overlay_canvas_layout('00000000-0000-4000-8000-000000005e03'::uuid, 'prf02s7vl-expired-fingerprint');
  if row_count <> 0 then raise exception 'an expired overlay session must return zero rows, got %', row_count; end if;

  select count(*) into row_count from app_private.list_overlay_canvas_layout('00000000-0000-4000-8000-000000005e04'::uuid, 'prf02s7vl-revoked-fingerprint');
  if row_count <> 0 then raise exception 'a revoked overlay session must return zero rows, got %', row_count; end if;
end
$$;

-- =========================================================================
-- 9. CROSS-CHANNEL ISOLATION: channel 0012's overlay session (still
--    free-tier, never configured) reads its OWN default horizontal --
--    never channel 0011's vertical configuration.
-- =========================================================================
do $$
declare v_layout text;
begin
  select layout into v_layout from app_private.list_overlay_canvas_layout('00000000-0000-4000-8000-000000005e02'::uuid, 'prf02s7vl-other-channel-fingerprint');
  if v_layout <> 'horizontal' then raise exception 'another channel''s overlay session must never see this channel''s vertical configuration, got %', v_layout; end if;
end
$$;

-- =========================================================================
-- 10. CREATOR READ: visible to every channel member; zero rows to a
--     non-member.
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
    select count(*) into row_count from app_private.get_channel_canvas_layout('00000000-0000-4000-8000-000000000011'::uuid);
    if row_count <> 1 then
      raise exception 'member % must see the channel''s canvas layout, got % row(s)', probe.user_id, row_count;
    end if;
  end loop;

  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000002', false);
  select count(*) into row_count from app_private.get_channel_canvas_layout('00000000-0000-4000-8000-000000000011'::uuid);
  if row_count <> 0 then raise exception 'a non-member must see zero rows, got %', row_count; end if;
end
$$;

-- =========================================================================
-- 11. Unrecognised tier fails closed (raises), matching every other
--     *_tier_rank helper's posture -- never silently resolved.
-- =========================================================================
do $$
declare raised boolean := false;
begin
  begin
    perform app_private.canvas_layout_tier_rank('enterprise');
  exception when others then
    raised := true;
  end;
  if not raised then
    raise exception 'an unrecognised tier must raise, not silently resolve a canvas layout tier rank';
  end if;
end
$$;
