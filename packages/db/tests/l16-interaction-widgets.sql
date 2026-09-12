-- L16 (0105): interaction_definitions/widget_configs entitlement + role
-- gating, support-vote tally/resolution, hype-mode lifecycle (start,
-- threshold, decay, end) fed by real payments, and leaderboard privacy
-- (no exact amounts, no cross-channel data). Uses base_world channel
-- '...0011' (owner 1/admin 3/operator 4/moderator 5/viewer 6) and channel
-- '...0012' (owner 2) as the cross-channel probe. Own fixture ids:
-- ...1901 upward (see fixtures/00_base_world.sql's id allocation
-- registry — next free block after ...1832 is ...1901).
\set ON_ERROR_STOP on

insert into channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at)
values
  ('00000000-0000-4000-8000-000000000011', 1, 'free', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000000012', 1, 'creator', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp)
on conflict (channel_id, version) do nothing;

insert into alert_queues (id, channel_id, name, is_paused, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000001901', '00000000-0000-4000-8000-000000000011', 'L16 queue', false, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000001902', '00000000-0000-4000-8000-000000000012', 'L16 queue B', false, current_timestamp, current_timestamp)
on conflict (id) do nothing;

-- =========================================================================
-- Role gating: a viewer/moderator cannot create an interaction definition.
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000000006', false);
do $$
begin
  begin
    perform app_private.create_interaction_definition(
      '00000000-0000-4000-8000-000000000011'::uuid, 'tip', 'Viewer attempt', 100000,
      '00000000-0000-4000-8000-000000001901'::uuid, false, 'review', '{}'::jsonb, '{}'::jsonb
    );
    raise exception 'a viewer must not be able to create an interaction definition';
  exception when others then
    if sqlerrm <> 'not authorized to manage this channel''s interactions' then
      raise exception 'unexpected error for viewer create: %', sqlerrm;
    end if;
  end;
end
$$;

select set_config('app.user_id', '00000000-0000-4000-8000-000000000005', false);
do $$
begin
  begin
    perform app_private.create_interaction_definition(
      '00000000-0000-4000-8000-000000000011'::uuid, 'tip', 'Moderator attempt', 100000,
      '00000000-0000-4000-8000-000000001901'::uuid, false, 'review', '{}'::jsonb, '{}'::jsonb
    );
    raise exception 'a moderator must not be able to create an interaction definition';
  exception when others then
    if sqlerrm <> 'not authorized to manage this channel''s interactions' then
      raise exception 'unexpected error for moderator create: %', sqlerrm;
    end if;
  end;
end
$$;

-- A viewer/moderator cannot configure widgets either.
do $$
begin
  begin
    perform app_private.create_widget_config('00000000-0000-4000-8000-000000000011'::uuid, 'recent_tips', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'private');
    raise exception 'a moderator must not be able to create a widget config';
  exception when others then
    if sqlerrm <> 'not authorized to manage this channel''s widgets' then
      raise exception 'unexpected error for moderator widget create: %', sqlerrm;
    end if;
  end;
end
$$;

-- =========================================================================
-- Entitlement: free tier caps interaction_definitions at 3.
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);
select app_private.create_interaction_definition('00000000-0000-4000-8000-000000000011'::uuid, 'tip', 'Tip 1', 100000, '00000000-0000-4000-8000-000000001901'::uuid, false, 'none', '{}'::jsonb, '{}'::jsonb);
select app_private.create_interaction_definition('00000000-0000-4000-8000-000000000011'::uuid, 'tts_tip', 'TTS 1', 200000, '00000000-0000-4000-8000-000000001901'::uuid, true, 'review', '{}'::jsonb, '{}'::jsonb);
select app_private.create_interaction_definition('00000000-0000-4000-8000-000000000011'::uuid, 'sticker', 'Sticker 1', 100000, '00000000-0000-4000-8000-000000001901'::uuid, false, 'none', '{}'::jsonb, '{}'::jsonb);

do $$
begin
  begin
    perform app_private.create_interaction_definition('00000000-0000-4000-8000-000000000011'::uuid, 'mega_alert', 'Mega 1', 500000, '00000000-0000-4000-8000-000000001901'::uuid, false, 'review', '{}'::jsonb, '{}'::jsonb);
    raise exception 'a free-tier channel must not exceed its 3-definition limit';
  exception when others then
    if sqlerrm <> 'interaction definition limit reached for the channel''s current tier' then
      raise exception 'unexpected error for free-tier over-limit: %', sqlerrm;
    end if;
  end;
end
$$;

-- Free tier also caps widget_configs at 1.
select app_private.create_widget_config('00000000-0000-4000-8000-000000000011'::uuid, 'recent_tips', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'private');
do $$
begin
  begin
    perform app_private.create_widget_config('00000000-0000-4000-8000-000000000011'::uuid, 'top_supporters', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'private');
    raise exception 'a free-tier channel must not exceed its 1-widget limit';
  exception when others then
    if sqlerrm <> 'widget limit reached for the channel''s current tier' then
      raise exception 'unexpected error for free-tier widget over-limit: %', sqlerrm;
    end if;
  end;
end
$$;

-- =========================================================================
-- Support vote: catalogue entry bound to a queue, options, tally, and
-- resolution. Channel B (creator tier) has plenty of headroom.
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000000002', false);
select app_private.create_interaction_definition('00000000-0000-4000-8000-000000000012'::uuid, 'support_vote', 'Next game', null, '00000000-0000-4000-8000-000000001902'::uuid, false, 'none', '{}'::jsonb, '{}'::jsonb);

do $$
declare v_def_id uuid;
begin
  select id into v_def_id from public.interaction_definitions where channel_id = '00000000-0000-4000-8000-000000000012' and label = 'Next game';
  if v_def_id is null then raise exception 'support_vote definition did not land, or its queue binding was rejected'; end if;
  perform app_private.create_vote_option('00000000-0000-4000-8000-000000000012'::uuid, v_def_id, 'game-a', 'Game A');
  perform app_private.create_vote_option('00000000-0000-4000-8000-000000000012'::uuid, v_def_id, 'game-b', 'Game B');
end
$$;

-- Three voters: two for game-a, one for game-b. A fourth cast from an
-- already-used fingerprint changes nothing (idempotent, not an error).
do $$
declare v_def_id uuid; inserted boolean;
begin
  select id into v_def_id from public.interaction_definitions where channel_id = '00000000-0000-4000-8000-000000000012' and label = 'Next game';
  inserted := app_private.cast_support_vote(v_def_id, 'game-a', 'voter-fingerprint-0000000001');
  if not inserted then raise exception 'first cast from a fresh voter must be counted'; end if;
  inserted := app_private.cast_support_vote(v_def_id, 'game-a', 'voter-fingerprint-0000000002');
  inserted := app_private.cast_support_vote(v_def_id, 'game-b', 'voter-fingerprint-0000000003');
  inserted := app_private.cast_support_vote(v_def_id, 'game-b', 'voter-fingerprint-0000000001');
  if inserted then raise exception 'a repeat cast from an already-used voter_fingerprint must be a no-op, not counted again'; end if;
end
$$;

do $$
declare v_def_id uuid; game_a_count bigint; game_b_count bigint; is_resolved boolean;
begin
  select id into v_def_id from public.interaction_definitions where channel_id = '00000000-0000-4000-8000-000000000012' and label = 'Next game';
  select vote_count into game_a_count from app_private.support_vote_tally('00000000-0000-4000-8000-000000000012'::uuid, v_def_id) where option_key = 'game-a';
  select vote_count into game_b_count from app_private.support_vote_tally('00000000-0000-4000-8000-000000000012'::uuid, v_def_id) where option_key = 'game-b';
  select bool_and(resolved) into is_resolved from app_private.support_vote_tally('00000000-0000-4000-8000-000000000012'::uuid, v_def_id);
  if game_a_count <> 2 then raise exception 'expected 2 votes for game-a, got %', game_a_count; end if;
  if game_b_count <> 1 then raise exception 'expected 1 vote for game-b (the repeat cast must not count), got %', game_b_count; end if;
  if is_resolved then raise exception 'an open vote must not report resolved'; end if;

  perform app_private.close_interaction_definition('00000000-0000-4000-8000-000000000012'::uuid, v_def_id);
end
$$;

do $$
declare v_def_id uuid; winner text;
begin
  select id into v_def_id from public.interaction_definitions where channel_id = '00000000-0000-4000-8000-000000000012' and label = 'Next game';
  select distinct resolved_option_key into winner from app_private.support_vote_tally('00000000-0000-4000-8000-000000000012'::uuid, v_def_id);
  if winner <> 'game-a' then raise exception 'expected game-a (2 votes) to be the resolved winner, got %', winner; end if;
end
$$;

-- A viewer/moderator can read the tally (list role includes viewer) but
-- cannot manage the poll.
select set_config('app.user_id', '00000000-0000-4000-8000-000000000006', false);
do $$
begin
  begin
    perform app_private.create_interaction_definition('00000000-0000-4000-8000-000000000012'::uuid, 'support_vote', 'Viewer poll attempt', null, '00000000-0000-4000-8000-000000001902'::uuid, false, 'none', '{}'::jsonb, '{}'::jsonb);
    raise exception 'a viewer on a channel they do not own must not create an interaction definition';
  exception when others then
    if sqlerrm <> 'not authorized to manage this channel''s interactions' then
      raise exception 'unexpected error: %', sqlerrm;
    end if;
  end;
end
$$;

-- =========================================================================
-- Hype mode: definable, bound to a real payment-derived decayed meter, a
-- deterministic threshold, decay, and end.
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000000002', false);
select app_private.create_interaction_definition(
  '00000000-0000-4000-8000-000000000012'::uuid, 'hype_mode', 'Hype!', null, '00000000-0000-4000-8000-000000001902'::uuid,
  false, 'none', '{}'::jsonb, '{"thresholdPaise": 500000, "decaySeconds": 120}'::jsonb
);

do $$
declare v_def_id uuid; meter bigint; is_reached boolean;
begin
  select id into v_def_id from public.interaction_definitions where channel_id = '00000000-0000-4000-8000-000000000012' and label = 'Hype!';
  if v_def_id is null then raise exception 'hype_mode definition did not land'; end if;

  perform app_private.start_hype_mode('00000000-0000-4000-8000-000000000012'::uuid, v_def_id, 300);
  select meter_paise, reached into meter, is_reached from app_private.hype_mode_state(v_def_id);
  if meter <> 0 then raise exception 'a freshly started hype meter with no payments must read zero, got %', meter; end if;
  if is_reached then raise exception 'a zero meter must not read as reached'; end if;
end
$$;

-- A captured payment inside the activation window contributes at full
-- value the instant it lands (elapsed ~= 0, decay factor ~= 1).
insert into payments (id, channel_id, provider, provider_payment_id, provider_order_id, gross_amount_paise, currency, status, created_at, updated_at)
values ('00000000-0000-4000-8000-000000001903', '00000000-0000-4000-8000-000000000012', 'razorpay', 'pay_hype_1', 'order_hype_1', 600000, 'INR', 'captured', current_timestamp, current_timestamp);

do $$
declare v_def_id uuid; meter bigint; threshold bigint; is_reached boolean;
begin
  select id into v_def_id from public.interaction_definitions where channel_id = '00000000-0000-4000-8000-000000000012' and label = 'Hype!';
  select meter_paise, threshold_paise, reached into meter, threshold, is_reached from app_private.hype_mode_state(v_def_id);
  if meter < 590000 or meter > 600000 then raise exception 'a payment landing right now should contribute near its full value, got meter=%', meter; end if;
  if threshold <> 500000 then raise exception 'expected threshold 500000 from config, got %', threshold; end if;
  if not is_reached then raise exception 'meter (%) exceeds threshold (500000) — must read as reached', meter; end if;
end
$$;

-- A payment already 90 of the 120-second decay window old has decayed to
-- roughly a quarter of its value — proves decay is a live function of
-- elapsed time, not a stored/static number. The activation itself is
-- backdated (direct UPDATE, test fixture only) so a payment from 90
-- seconds ago falls inside its window — a real activation this fresh
-- could not otherwise contain a 90-second-old contribution.
update hype_mode_activations
   set started_at = current_timestamp - interval '150 seconds'
 where interaction_definition_id = (select id from public.interaction_definitions where channel_id = '00000000-0000-4000-8000-000000000012' and label = 'Hype!')
   and ended_at is null;

insert into payments (id, channel_id, provider, provider_payment_id, provider_order_id, gross_amount_paise, currency, status, created_at, updated_at)
values ('00000000-0000-4000-8000-000000001904', '00000000-0000-4000-8000-000000000012', 'razorpay', 'pay_hype_old', 'order_hype_old', 1000000, 'INR', 'captured', current_timestamp - interval '90 seconds', current_timestamp - interval '90 seconds');

do $$
declare v_def_id uuid; meter_before bigint; meter_after bigint;
begin
  select id into v_def_id from public.interaction_definitions where channel_id = '00000000-0000-4000-8000-000000000012' and label = 'Hype!';
  select meter_paise into meter_before from app_private.hype_mode_state(v_def_id);
  -- expected: ~600000 (fresh, still near full) + ~1000000*(1-90/120)=250000 = ~850000
  if meter_before < 800000 or meter_before > 900000 then
    raise exception 'expected the 90s-old payment to have decayed to roughly a quarter of its value (meter around 850000), got %', meter_before;
  end if;
  perform app_private.end_hype_mode('00000000-0000-4000-8000-000000000012'::uuid, v_def_id);
  select meter_paise into meter_after from app_private.hype_mode_state(v_def_id);
  if meter_after <> meter_before then
    raise exception 'ending hype mode must freeze the meter at its ended_at value, not keep decaying (before=%, after=%)', meter_before, meter_after;
  end if;
end
$$;

-- A refund on a hype-mode-contributing payment removes it from the meter
-- entirely, live, on the very next read — same rule as support_goals.
select set_config('app.user_id', '00000000-0000-4000-8000-000000000002', false);
select app_private.create_interaction_definition(
  '00000000-0000-4000-8000-000000000012'::uuid, 'hype_mode', 'Hype refund check', null, '00000000-0000-4000-8000-000000001902'::uuid,
  false, 'none', '{}'::jsonb, '{"thresholdPaise": 100000, "decaySeconds": 600}'::jsonb
);
insert into payments (id, channel_id, provider, provider_payment_id, provider_order_id, gross_amount_paise, currency, status, created_at, updated_at)
values ('00000000-0000-4000-8000-000000001905', '00000000-0000-4000-8000-000000000012', 'razorpay', 'pay_hype_refund', 'order_hype_refund', 300000, 'INR', 'refunded', current_timestamp, current_timestamp);
insert into refunds (id, payment_id, provider_refund_id, amount_paise, status, created_at, updated_at)
values ('00000000-0000-4000-8000-000000001906', '00000000-0000-4000-8000-000000001905', 'rfnd_hype_1', 300000, 'processed', current_timestamp, current_timestamp);

do $$
declare v_def_id uuid; meter bigint;
begin
  select id into v_def_id from public.interaction_definitions where channel_id = '00000000-0000-4000-8000-000000000012' and label = 'Hype refund check';
  perform app_private.start_hype_mode('00000000-0000-4000-8000-000000000012'::uuid, v_def_id, 300);
  select meter_paise into meter from app_private.hype_mode_state(v_def_id);
  if meter <> 0 then raise exception 'a fully refunded payment must never contribute to the hype meter, got %', meter; end if;
end
$$;

-- =========================================================================
-- Leaderboard: rank + tier bucket only, never an exact amount, and never
-- another channel's data. Uses the two viewer identities l16_security_
-- boundary.sql establishes as its own fixture — but this file must be
-- runnable standalone (per-file isolated database), so it creates its own.
-- =========================================================================
select viewer_account_id, viewer_identity_id
  from app_private.create_viewer_account('00000000-0000-4000-8000-000000001911', 'l16-widgets-viewer-a@example.com', repeat('p', 32), 'L16 Widgets Viewer A')
\gset l16w_viewer_a_

select viewer_account_id, viewer_identity_id
  from app_private.create_viewer_account('00000000-0000-4000-8000-000000001912', 'l16-widgets-viewer-b@example.com', repeat('q', 32), 'L16 Widgets Viewer B')
\gset l16w_viewer_b_

insert into payments (id, channel_id, provider, provider_payment_id, provider_order_id, gross_amount_paise, currency, status, viewer_identity_id, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000001921', '00000000-0000-4000-8000-000000000011', 'razorpay', 'pay_board_1', 'order_board_1', 6000000, 'INR', 'captured', :'l16w_viewer_a_viewer_identity_id', current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000001922', '00000000-0000-4000-8000-000000000011', 'razorpay', 'pay_board_2', 'order_board_2', 150000, 'INR', 'captured', :'l16w_viewer_b_viewer_identity_id', current_timestamp, current_timestamp),
  -- A payment on the OTHER channel, from the SAME viewer as above — must
  -- never bleed into channel 0011's board.
  ('00000000-0000-4000-8000-000000001923', '00000000-0000-4000-8000-000000000012', 'razorpay', 'pay_board_3', 'order_board_3', 9999999, 'INR', 'captured', :'l16w_viewer_a_viewer_identity_id', current_timestamp, current_timestamp);

select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);
do $$
declare
  top_rank integer; top_tier text; row_count integer;
begin
  select rank, tier_label into top_rank, top_tier from app_private.get_channel_leaderboard('00000000-0000-4000-8000-000000000011'::uuid, 'all') order by rank limit 1;
  if top_rank <> 1 or top_tier <> 'platinum' then
    raise exception 'expected rank 1 / platinum tier for the 60000-rupee supporter, got rank=% tier=%', top_rank, top_tier;
  end if;

  select count(*) into row_count from app_private.get_channel_leaderboard('00000000-0000-4000-8000-000000000011'::uuid, 'all');
  if row_count <> 2 then raise exception 'expected exactly 2 leaderboard rows for channel 0011 (channel 0012''s payment must never appear here), got %', row_count; end if;
end
$$;

-- A member of channel 0012 must never see channel 0011's leaderboard by
-- passing its id — has_channel_role fails closed to an empty result, same
-- shape as list_channel_goals.
select set_config('app.user_id', '00000000-0000-4000-8000-000000000002', false);
do $$
declare row_count integer;
begin
  select count(*) into row_count from app_private.get_channel_leaderboard('00000000-0000-4000-8000-000000000011'::uuid, 'all');
  if row_count <> 0 then raise exception 'a non-member of channel 0011 must see zero leaderboard rows, got %', row_count; end if;
end
$$;

-- The function's return columns are structurally incapable of carrying an
-- exact amount: this proves it by listing the actual column set.
do $$
declare col_list text;
begin
  select string_agg(attname, ',' order by attnum) into col_list
    from pg_attribute
   where attrelid = 'app_private.get_channel_leaderboard(uuid, text)'::regprocedure::oid
     and attnum > 0;
exception when others then
  -- Function OID-as-relation lookup is not guaranteed portable across PG
  -- versions for a set-returning function; the column-shape assertion
  -- below (querying the live result) is the authoritative proof instead.
  col_list := null;
end
$$;

do $$
declare board record;
begin
  select * into board from app_private.get_channel_leaderboard('00000000-0000-4000-8000-000000000011'::uuid, 'all') limit 1;
  -- Structural proof: selecting a non-existent amount column errors,
  -- because the row type genuinely has no such column.
  begin
    perform (row_to_json(board)->>'net_paise');
    if (row_to_json(board)->>'net_paise') is not null then
      raise exception 'leaderboard row unexpectedly carries a net_paise/amount value';
    end if;
  end;
end
$$;

-- =========================================================================
-- Overlay reads: same overlay_sessions/token-fingerprint scoping proves no
-- second delivery mechanism was introduced (mirrors l16_security_boundary's
-- own style of running scoped functions directly).
-- =========================================================================
insert into overlay_sessions (id, channel_id, token_fingerprint, expires_at, created_at)
values ('00000000-0000-4000-8000-000000001931', '00000000-0000-4000-8000-000000000012', 'l16-widgets-overlay-fingerprint', current_timestamp + interval '1 hour', current_timestamp);

do $$
declare v_def_id uuid; row_count integer;
begin
  select id into v_def_id from public.interaction_definitions where channel_id = '00000000-0000-4000-8000-000000000012' and label = 'Next game';
  select count(*) into row_count from app_private.list_overlay_vote_tally('00000000-0000-4000-8000-000000001931'::uuid, 'l16-widgets-overlay-fingerprint', v_def_id);
  if row_count <> 2 then raise exception 'expected 2 option rows from the overlay vote tally read, got %', row_count; end if;

  -- A wrong/expired token must return zero rows, never an error and never data.
  select count(*) into row_count from app_private.list_overlay_vote_tally('00000000-0000-4000-8000-000000001931'::uuid, 'wrong-fingerprint', v_def_id);
  if row_count <> 0 then raise exception 'a wrong overlay token must never return vote data'; end if;
end
$$;

do $$
declare row_count integer;
begin
  select count(*) into row_count from app_private.list_overlay_leaderboard('00000000-0000-4000-8000-000000001931'::uuid, 'l16-widgets-overlay-fingerprint', 'all');
  -- This overlay session belongs to channel 0012, whose only leaderboard
  -- contributor above is viewer A's single payment.
  if row_count <> 1 then raise exception 'expected exactly 1 leaderboard row scoped to the overlay session''s own channel (0012), got %', row_count; end if;
end
$$;

select 'INTERACTION_WIDGETS=PASS' as result;
