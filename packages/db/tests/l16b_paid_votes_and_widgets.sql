-- L16 gap closure (0108): paid support votes (money-derived tally, refund
-- behaviour, free-mode-still-works, paid-tagging rejected on a free
-- definition) and the four new widget overlay reads (recent_tips,
-- top_supporters, supporter_ticker, mega_tip_banner) — privacy proof that
-- a non-opted-in / other-channel viewer never appears, and that a bad
-- overlay token never returns data. Uses base_world channel '...0011'
-- (owner 1) and '...0012' (owner 2, the cross-channel probe). Own fixture
-- ids: ...2100 upward (see l16-interaction-widgets.sql's own block for
-- precedent; this file is runnable standalone in its own isolated
-- database per run-sql-suite.sh, so only collisions with
-- fixtures/00_base_world.sql matter).
\set ON_ERROR_STOP on

insert into channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at)
values
  ('00000000-0000-4000-8000-000000000011', 1, 'creator', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000000012', 1, 'creator', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp)
on conflict (channel_id, version) do nothing;

insert into alert_queues (id, channel_id, name, is_paused, created_at, updated_at)
values ('00000000-0000-4000-8000-000000002101', '00000000-0000-4000-8000-000000000011', 'L16b queue', false, current_timestamp, current_timestamp)
on conflict (id) do nothing;

-- =========================================================================
-- Paid vote: definition + options + payment chain (payment_accounts ->
-- payment_order_intents -> payments), mirroring l14-receipts-claims-
-- badges-profiles.sql's own fixture shape for that chain exactly.
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);
select app_private.create_interaction_definition(
  '00000000-0000-4000-8000-000000000011'::uuid, 'support_vote', 'Paid poll', null,
  '00000000-0000-4000-8000-000000002101'::uuid, false, 'none', '{}'::jsonb, '{"votingMode": "paid"}'::jsonb
);

do $$
declare v_def_id uuid;
begin
  select id into v_def_id from public.interaction_definitions where channel_id = '00000000-0000-4000-8000-000000000011' and label = 'Paid poll';
  if v_def_id is null then raise exception 'paid support_vote definition did not land'; end if;
  perform app_private.create_vote_option('00000000-0000-4000-8000-000000000011'::uuid, v_def_id, 'option-a', 'Option A');
  perform app_private.create_vote_option('00000000-0000-4000-8000-000000000011'::uuid, v_def_id, 'option-b', 'Option B');
end
$$;

insert into payment_accounts (id, channel_id, provider, environment, connected_account_ref, status, created_at, updated_at)
values ('00000000-0000-4000-8000-000000002110', '00000000-0000-4000-8000-000000000011', 'razorpay', 'test', 'acct_l16b', 'active', current_timestamp, current_timestamp);

-- Payment 1: ₹3000 tagged to option-a.
insert into payment_order_intents (id, channel_id, payment_account_id, provider, environment, connected_account_ref, idempotency_key, provider_receipt, provider_order_id, gross_amount_paise, currency, donor_display_name, donor_message, alert_consent, status, expires_at, created_at, updated_at)
values ('00000000-0000-4000-8000-000000002111', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000002110', 'razorpay', 'test', 'acct_l16b', 'l16b-idem-a1-0000001', 'l16b-receipt-a1-000001', 'order_l16b_a1', 300000, 'INR', 'Amit', '', true, 'paid', current_timestamp + interval '10 minutes', current_timestamp, current_timestamp);
insert into payments (id, channel_id, provider, provider_payment_id, provider_order_id, gross_amount_paise, currency, status, environment, connected_account_ref, created_at, updated_at)
values ('00000000-0000-4000-8000-000000002112', '00000000-0000-4000-8000-000000000011', 'razorpay', 'pay_l16b_a1', 'order_l16b_a1', 300000, 'INR', 'captured', 'test', 'acct_l16b', current_timestamp, current_timestamp);

-- Payment 2: ₹1000 tagged to option-b.
insert into payment_order_intents (id, channel_id, payment_account_id, provider, environment, connected_account_ref, idempotency_key, provider_receipt, provider_order_id, gross_amount_paise, currency, donor_display_name, donor_message, alert_consent, status, expires_at, created_at, updated_at)
values ('00000000-0000-4000-8000-000000002113', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000002110', 'razorpay', 'test', 'acct_l16b', 'l16b-idem-b1-0000001', 'l16b-receipt-b1-000001', 'order_l16b_b1', 100000, 'INR', 'Bala', '', true, 'paid', current_timestamp + interval '10 minutes', current_timestamp, current_timestamp);
insert into payments (id, channel_id, provider, provider_payment_id, provider_order_id, gross_amount_paise, currency, status, environment, connected_account_ref, created_at, updated_at)
values ('00000000-0000-4000-8000-000000002114', '00000000-0000-4000-8000-000000000011', 'razorpay', 'pay_l16b_b1', 'order_l16b_b1', 100000, 'INR', 'captured', 'test', 'acct_l16b', current_timestamp, current_timestamp);

do $$
declare v_def_id uuid;
begin
  select id into v_def_id from public.interaction_definitions where channel_id = '00000000-0000-4000-8000-000000000011' and label = 'Paid poll';
  perform app_private.tag_vote_payment('00000000-0000-4000-8000-000000000011'::uuid, 'test', 'l16b-idem-a1-0000001', v_def_id, 'option-a');
  perform app_private.tag_vote_payment('00000000-0000-4000-8000-000000000011'::uuid, 'test', 'l16b-idem-b1-0000001', v_def_id, 'option-b');

  -- A retry with the same idempotency key + same tag is a no-op, not an error.
  perform app_private.tag_vote_payment('00000000-0000-4000-8000-000000000011'::uuid, 'test', 'l16b-idem-a1-0000001', v_def_id, 'option-a');
end
$$;

-- THE PAID-VOTE TEST: tally reflects real money, not headcount.
do $$
declare v_def_id uuid; amount_a bigint; amount_b bigint;
begin
  select id into v_def_id from public.interaction_definitions where channel_id = '00000000-0000-4000-8000-000000000011' and label = 'Paid poll';
  select amount_paise into amount_a from app_private.paid_support_vote_tally('00000000-0000-4000-8000-000000000011'::uuid, v_def_id) where option_key = 'option-a';
  select amount_paise into amount_b from app_private.paid_support_vote_tally('00000000-0000-4000-8000-000000000011'::uuid, v_def_id) where option_key = 'option-b';
  if amount_a <> 300000 then raise exception 'expected option-a paid tally of 300000, got %', amount_a; end if;
  if amount_b <> 100000 then raise exception 'expected option-b paid tally of 100000, got %', amount_b; end if;
end
$$;

-- A duplicate idempotency key retagged to a DIFFERENT option must be rejected.
do $$
declare v_def_id uuid;
begin
  select id into v_def_id from public.interaction_definitions where channel_id = '00000000-0000-4000-8000-000000000011' and label = 'Paid poll';
  begin
    perform app_private.tag_vote_payment('00000000-0000-4000-8000-000000000011'::uuid, 'test', 'l16b-idem-a1-0000001', v_def_id, 'option-b');
    raise exception 'retagging an idempotency key to a different option must be rejected';
  exception when others then
    if sqlerrm <> 'idempotency key already tagged with a different vote option' then
      raise exception 'unexpected error for retag: %', sqlerrm;
    end if;
  end;
end
$$;

-- THE REFUND TEST: a processed refund on the option-a payment reduces its
-- tally on the very next read — no event to miss, no counter to desync.
insert into refunds (id, payment_id, provider_refund_id, amount_paise, status, created_at, updated_at)
values ('00000000-0000-4000-8000-000000002115', '00000000-0000-4000-8000-000000002112', 'rfnd_l16b_a1', 120000, 'processed', current_timestamp, current_timestamp);

do $$
declare v_def_id uuid; amount_a bigint;
begin
  select id into v_def_id from public.interaction_definitions where channel_id = '00000000-0000-4000-8000-000000000011' and label = 'Paid poll';
  select amount_paise into amount_a from app_private.paid_support_vote_tally('00000000-0000-4000-8000-000000000011'::uuid, v_def_id) where option_key = 'option-a';
  if amount_a <> 180000 then raise exception 'expected option-a paid tally to net the 120000 refund down to 180000, got %', amount_a; end if;
end
$$;

-- =========================================================================
-- Free vote mode still works, unaffected by this migration — a definition
-- with no votingMode config (or votingMode != 'paid') uses the ORIGINAL
-- 0105 headcount path (cast_support_vote/support_vote_tally), untouched.
-- =========================================================================
select app_private.create_interaction_definition(
  '00000000-0000-4000-8000-000000000011'::uuid, 'support_vote', 'Free poll', null,
  '00000000-0000-4000-8000-000000002101'::uuid, false, 'none', '{}'::jsonb, '{}'::jsonb
);
do $$
declare v_def_id uuid; game_count bigint; tagged uuid;
begin
  select id into v_def_id from public.interaction_definitions where channel_id = '00000000-0000-4000-8000-000000000011' and label = 'Free poll';
  perform app_private.create_vote_option('00000000-0000-4000-8000-000000000011'::uuid, v_def_id, 'yes', 'Yes');
  perform app_private.cast_support_vote(v_def_id, 'yes', 'l16b-voter-0000000001');
  perform app_private.cast_support_vote(v_def_id, 'yes', 'l16b-voter-0000000002');
  select vote_count into game_count from app_private.support_vote_tally('00000000-0000-4000-8000-000000000011'::uuid, v_def_id) where option_key = 'yes';
  if game_count <> 2 then raise exception 'free headcount vote must still work unmodified, expected 2 got %', game_count; end if;

  -- A caller cannot pay-tag a free-mode definition — mode selection is
  -- enforced server-side, not left to the caller's honesty.
  begin
    tagged := app_private.tag_vote_payment('00000000-0000-4000-8000-000000000011'::uuid, 'test', 'l16b-idem-free-attempt-0001', v_def_id, 'yes');
    raise exception 'a free-mode support vote must reject a paid tag attempt';
  exception when others then
    if sqlerrm <> 'this support vote is not configured for paid voting' then
      raise exception 'unexpected error tagging a free definition: %', sqlerrm;
    end if;
  end;
end
$$;

-- =========================================================================
-- Overlay reads for the paid tally + widgets. Session on channel 0011.
-- =========================================================================
insert into overlay_sessions (id, channel_id, token_fingerprint, expires_at, created_at)
values ('00000000-0000-4000-8000-000000002120', '00000000-0000-4000-8000-000000000011', 'l16b-overlay-fingerprint', current_timestamp + interval '1 hour', current_timestamp);

do $$
declare v_def_id uuid; amount_a bigint; row_count integer;
begin
  select id into v_def_id from public.interaction_definitions where channel_id = '00000000-0000-4000-8000-000000000011' and label = 'Paid poll';
  select amount_paise into amount_a from app_private.list_overlay_paid_vote_tally('00000000-0000-4000-8000-000000002120'::uuid, 'l16b-overlay-fingerprint', v_def_id) where option_key = 'option-a';
  if amount_a <> 180000 then raise exception 'overlay paid tally must match the dashboard read, expected 180000 got %', amount_a; end if;

  -- OVERLAY AUTH REJECTS A BAD TOKEN: wrong fingerprint returns zero rows, never an error and never data.
  select count(*) into row_count from app_private.list_overlay_paid_vote_tally('00000000-0000-4000-8000-000000002120'::uuid, 'wrong-fingerprint', v_def_id);
  if row_count <> 0 then raise exception 'a wrong overlay token must never return paid vote data'; end if;
end
$$;

-- =========================================================================
-- recent_tips: consented tip event with a real donor_display_name/message.
-- =========================================================================
insert into alert_events (id, channel_id, payment_id, source_type, source_id, trace_id, config_snapshot_version, payload, created_at)
values ('00000000-0000-4000-8000-000000002130', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000002112', 'payment', 'pay_l16b_a1', 'trace-l16b-1', 1, jsonb_build_object('displayName', 'Amit', 'message', 'Great stream!'), current_timestamp);

do $$
declare tip_name text; tip_amount bigint; row_count integer;
begin
  select display_name, amount_paise into tip_name, tip_amount
    from app_private.list_overlay_recent_tips('00000000-0000-4000-8000-000000002120'::uuid, 'l16b-overlay-fingerprint')
   order by created_at desc limit 1;
  if tip_name <> 'Amit' then raise exception 'expected recent tip display name Amit, got %', tip_name; end if;
  if tip_amount <> 300000 then raise exception 'expected recent tip amount 300000, got %', tip_amount; end if;

  select count(*) into row_count from app_private.list_overlay_recent_tips('00000000-0000-4000-8000-000000002120'::uuid, 'wrong-fingerprint');
  if row_count <> 0 then raise exception 'a wrong overlay token must never return recent-tips data'; end if;
end
$$;

-- =========================================================================
-- mega_tip_banner: only a recent, qualifying (>= 500000 paise), consented
-- tip appears; a smaller or stale one never does.
-- =========================================================================
do $$
declare row_count integer;
begin
  -- 300000 < the 500000 floor: must not appear as a banner.
  select count(*) into row_count from app_private.list_overlay_mega_tip_banner('00000000-0000-4000-8000-000000002120'::uuid, 'l16b-overlay-fingerprint');
  if row_count <> 0 then raise exception 'a sub-threshold tip must never trigger the mega tip banner, got % rows', row_count; end if;
end
$$;

insert into payments (id, channel_id, provider, provider_payment_id, provider_order_id, gross_amount_paise, currency, status, created_at, updated_at)
values ('00000000-0000-4000-8000-000000002131', '00000000-0000-4000-8000-000000000011', 'razorpay', 'pay_l16b_mega1', 'order_l16b_mega1', 750000, 'INR', 'captured', current_timestamp, current_timestamp);
insert into alert_events (id, channel_id, payment_id, source_type, source_id, trace_id, config_snapshot_version, payload, created_at)
values ('00000000-0000-4000-8000-000000002132', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000002131', 'payment', 'pay_l16b_mega1', 'trace-l16b-mega1', 1, jsonb_build_object('displayName', 'Chandra'), current_timestamp);

-- A qualifying but STALE (21 minutes old, past the 15-minute window) tip
-- must not appear either — inserted first so the fresh one below wins.
insert into payments (id, channel_id, provider, provider_payment_id, provider_order_id, gross_amount_paise, currency, status, created_at, updated_at)
values ('00000000-0000-4000-8000-000000002133', '00000000-0000-4000-8000-000000000011', 'razorpay', 'pay_l16b_mega_stale', 'order_l16b_mega_stale', 900000, 'INR', 'captured', current_timestamp - interval '21 minutes', current_timestamp - interval '21 minutes');
insert into alert_events (id, channel_id, payment_id, source_type, source_id, trace_id, config_snapshot_version, payload, created_at)
values ('00000000-0000-4000-8000-000000002134', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000002133', 'payment', 'pay_l16b_mega_stale', 'trace-l16b-mega-stale', 1, jsonb_build_object('displayName', 'StaleSupporter'), current_timestamp - interval '21 minutes');

do $$
declare banner_name text; banner_amount bigint; row_count integer;
begin
  select count(*) into row_count from app_private.list_overlay_mega_tip_banner('00000000-0000-4000-8000-000000002120'::uuid, 'l16b-overlay-fingerprint');
  if row_count <> 1 then raise exception 'expected exactly 1 qualifying, fresh mega-tip banner row, got %', row_count; end if;

  select display_name, amount_paise into banner_name, banner_amount
    from app_private.list_overlay_mega_tip_banner('00000000-0000-4000-8000-000000002120'::uuid, 'l16b-overlay-fingerprint');
  if banner_name <> 'Chandra' then raise exception 'expected the fresh qualifying tip (Chandra), got %', banner_name; end if;
  if banner_amount <> 750000 then raise exception 'expected banner amount 750000, got %', banner_amount; end if;
end
$$;

-- =========================================================================
-- top_supporters / supporter_ticker: privacy proof. Two viewer accounts;
-- one supports channel 0011, the other supports ONLY channel 0012. Neither
-- viewer's email/display_name is ever selectable from these functions —
-- only an anonymised viewer_ref + coarse tier bucket, and only this
-- channel's own supporters.
-- =========================================================================
select viewer_account_id, viewer_identity_id
  from app_private.create_viewer_account('00000000-0000-4000-8000-000000002140', 'l16b-viewer-a@example.com', repeat('p', 32), 'L16b Viewer A')
\gset l16b_viewer_a_

select viewer_account_id, viewer_identity_id
  from app_private.create_viewer_account('00000000-0000-4000-8000-000000002141', 'l16b-viewer-b-other-channel-only@example.com', repeat('q', 32), 'L16b Viewer B')
\gset l16b_viewer_b_

insert into payments (id, channel_id, provider, provider_payment_id, provider_order_id, gross_amount_paise, currency, status, viewer_identity_id, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000002142', '00000000-0000-4000-8000-000000000011', 'razorpay', 'pay_l16b_sup1', 'order_l16b_sup1', 6000000, 'INR', 'captured', :'l16b_viewer_a_viewer_identity_id', current_timestamp, current_timestamp),
  -- Fully refunded: must never appear in the supporter ticker.
  ('00000000-0000-4000-8000-000000002143', '00000000-0000-4000-8000-000000000011', 'razorpay', 'pay_l16b_sup2', 'order_l16b_sup2', 150000, 'INR', 'refunded', :'l16b_viewer_a_viewer_identity_id', current_timestamp, current_timestamp),
  -- Viewer B supports ONLY channel 0012 — must never appear on 0011's widgets.
  ('00000000-0000-4000-8000-000000002144', '00000000-0000-4000-8000-000000000012', 'razorpay', 'pay_l16b_sup3', 'order_l16b_sup3', 9999999, 'INR', 'captured', :'l16b_viewer_b_viewer_identity_id', current_timestamp, current_timestamp);

-- psql does not substitute :'variables' inside a dollar-quoted (do $$...$$)
-- body (see l14_viewer_identity.sql's own comment on this) — stash both
-- refs into session GUCs at the top level, read them back inside the
-- block via current_setting.
select set_config('l16b.a_ref', 'viewer_' || substr(:'l16b_viewer_a_viewer_identity_id', 1, 8), false);
select set_config('l16b.b_ref', 'viewer_' || substr(:'l16b_viewer_b_viewer_identity_id', 1, 8), false);

do $$
declare row_count integer; a_ref text; b_ref text;
begin
  a_ref := current_setting('l16b.a_ref');
  b_ref := current_setting('l16b.b_ref');

  -- top_supporters: only viewer A's channel-0011 activity appears.
  select count(*) into row_count from app_private.list_overlay_top_supporters('00000000-0000-4000-8000-000000002120'::uuid, 'l16b-overlay-fingerprint');
  if row_count <> 1 then raise exception 'expected exactly 1 top-supporter row for channel 0011, got %', row_count; end if;
  perform 1 from app_private.list_overlay_top_supporters('00000000-0000-4000-8000-000000002120'::uuid, 'l16b-overlay-fingerprint') where viewer_ref = a_ref;
  if not found then raise exception 'expected viewer A''s anonymised ref in top_supporters'; end if;
  perform 1 from app_private.list_overlay_top_supporters('00000000-0000-4000-8000-000000002120'::uuid, 'l16b-overlay-fingerprint') where viewer_ref = b_ref;
  if found then raise exception 'viewer B (a different channel''s supporter) must never appear in channel 0011''s top_supporters'; end if;

  -- supporter_ticker: viewer A's captured payment appears, the fully
  -- refunded one does not add a second/duplicate qualifying row, and
  -- viewer B never appears.
  select count(*) into row_count from app_private.list_overlay_supporter_ticker('00000000-0000-4000-8000-000000002120'::uuid, 'l16b-overlay-fingerprint');
  if row_count <> 1 then raise exception 'expected exactly 1 supporter-ticker row (the refunded payment must be excluded), got %', row_count; end if;
  perform 1 from app_private.list_overlay_supporter_ticker('00000000-0000-4000-8000-000000002120'::uuid, 'l16b-overlay-fingerprint') where viewer_ref = a_ref;
  if not found then raise exception 'expected viewer A''s anonymised ref in supporter_ticker'; end if;
  perform 1 from app_private.list_overlay_supporter_ticker('00000000-0000-4000-8000-000000002120'::uuid, 'l16b-overlay-fingerprint') where viewer_ref = b_ref;
  if found then raise exception 'viewer B (a different channel''s supporter) must never appear in channel 0011''s supporter_ticker';
  end if;

  -- Wrong token: zero rows from both, never an error.
  select count(*) into row_count from app_private.list_overlay_top_supporters('00000000-0000-4000-8000-000000002120'::uuid, 'wrong-fingerprint');
  if row_count <> 0 then raise exception 'a wrong overlay token must never return top_supporters data'; end if;
  select count(*) into row_count from app_private.list_overlay_supporter_ticker('00000000-0000-4000-8000-000000002120'::uuid, 'wrong-fingerprint');
  if row_count <> 0 then raise exception 'a wrong overlay token must never return supporter_ticker data'; end if;
end
$$;

-- Structural proof (same technique as l16-interaction-widgets.sql's
-- leaderboard test): the top_supporters/supporter_ticker row types
-- genuinely have no email/display_name column to leak from.
do $$
declare row1 record; row2 record;
begin
  select * into row1 from app_private.list_overlay_top_supporters('00000000-0000-4000-8000-000000002120'::uuid, 'l16b-overlay-fingerprint') limit 1;
  if (row_to_json(row1)->>'email') is not null or (row_to_json(row1)->>'display_name') is not null then
    raise exception 'top_supporters row unexpectedly carries an email/display_name value';
  end if;
  select * into row2 from app_private.list_overlay_supporter_ticker('00000000-0000-4000-8000-000000002120'::uuid, 'l16b-overlay-fingerprint') limit 1;
  if (row_to_json(row2)->>'email') is not null or (row_to_json(row2)->>'display_name') is not null then
    raise exception 'supporter_ticker row unexpectedly carries an email/display_name value';
  end if;
end
$$;

select 'PAID_VOTES_AND_WIDGETS=PASS' as result;
