-- PRF-02 slice 2, module #3 (Tug-of-War Vote): app_private.
-- list_overlay_tug_of_war_vote (0132). Money-derived tally correctness
-- (mirrors l16b_paid_votes_and_widgets.sql's own paid-vote proof, reused
-- rather than re-derived), the "exactly two options, prefer open over
-- closed" resolution rule 0132's header states, resolved-state surfacing,
-- bad-token/cross-channel isolation. Uses base_world channel '...0011'
-- (owner 1) and '...0012' (owner 2, the cross-channel probe); own
-- fixture ids ...2200 upward (l16b_paid_votes_and_widgets.sql already
-- owns the ...2100 range in the same shared base world — see that file's
-- own header for why only that collision matters, this file being
-- runnable standalone in its own isolated database per run-sql-suite.sh).
\set ON_ERROR_STOP on

insert into channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at)
values
  ('00000000-0000-4000-8000-000000000011', 1, 'creator', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000000012', 1, 'creator', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp)
on conflict (channel_id, version) do nothing;

insert into alert_queues (id, channel_id, name, is_paused, created_at, updated_at)
values ('00000000-0000-4000-8000-000000002201', '00000000-0000-4000-8000-000000000011', 'PRF-02 slice2 queue', false, current_timestamp, current_timestamp)
on conflict (id) do nothing;

select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);

-- =========================================================================
-- Eligibility: a FREE (headcount) vote and a paid vote with THREE options
-- must both be ignored by the resolver — only an is_enabled, paid,
-- EXACTLY-TWO-OPTION support_vote is eligible.
-- =========================================================================
select app_private.create_interaction_definition(
  '00000000-0000-4000-8000-000000000011'::uuid, 'support_vote', 'Free poll (ignored)', null,
  '00000000-0000-4000-8000-000000002201'::uuid, false, 'none', '{}'::jsonb, '{}'::jsonb
);
select app_private.create_interaction_definition(
  '00000000-0000-4000-8000-000000000011'::uuid, 'support_vote', 'Three-way paid poll (ignored)', null,
  '00000000-0000-4000-8000-000000002201'::uuid, false, 'none', '{}'::jsonb, '{"votingMode": "paid"}'::jsonb
);
do $$
declare v_free_id uuid; v_three_id uuid;
begin
  select id into v_free_id from public.interaction_definitions where channel_id = '00000000-0000-4000-8000-000000000011' and label = 'Free poll (ignored)';
  perform app_private.create_vote_option('00000000-0000-4000-8000-000000000011'::uuid, v_free_id, 'a', 'A');
  perform app_private.create_vote_option('00000000-0000-4000-8000-000000000011'::uuid, v_free_id, 'b', 'B');

  select id into v_three_id from public.interaction_definitions where channel_id = '00000000-0000-4000-8000-000000000011' and label = 'Three-way paid poll (ignored)';
  perform app_private.create_vote_option('00000000-0000-4000-8000-000000000011'::uuid, v_three_id, 'x', 'X');
  perform app_private.create_vote_option('00000000-0000-4000-8000-000000000011'::uuid, v_three_id, 'y', 'Y');
  perform app_private.create_vote_option('00000000-0000-4000-8000-000000000011'::uuid, v_three_id, 'z', 'Z');
end
$$;

insert into overlay_sessions (id, channel_id, token_fingerprint, expires_at, created_at)
values ('00000000-0000-4000-8000-000000002220', '00000000-0000-4000-8000-000000000011', 'prf02s2-overlay-fingerprint', current_timestamp + interval '1 hour', current_timestamp);

do $$
declare row_count integer;
begin
  select count(*) into row_count from app_private.list_overlay_tug_of_war_vote('00000000-0000-4000-8000-000000002220'::uuid, 'prf02s2-overlay-fingerprint');
  if row_count <> 0 then raise exception 'with no eligible (two-sided, paid, enabled) vote configured, the overlay read must return zero rows, got %', row_count; end if;
end
$$;

-- =========================================================================
-- THE MONEY-DERIVED TALLY TEST: a real two-sided paid vote, payments
-- tagged to each side, tally read via the NEW overlay function must match
-- what was actually paid — exactly the same join 0108's paid_support_
-- vote_tally/list_overlay_paid_vote_tally already prove, reused here.
-- =========================================================================
select app_private.create_interaction_definition(
  '00000000-0000-4000-8000-000000000011'::uuid, 'support_vote', 'Tug of war A', null,
  '00000000-0000-4000-8000-000000002201'::uuid, false, 'none', '{}'::jsonb, '{"votingMode": "paid"}'::jsonb
);
do $$
declare v_def_id uuid;
begin
  select id into v_def_id from public.interaction_definitions where channel_id = '00000000-0000-4000-8000-000000000011' and label = 'Tug of war A';
  perform app_private.create_vote_option('00000000-0000-4000-8000-000000000011'::uuid, v_def_id, 'team-red', 'Team Red');
  perform app_private.create_vote_option('00000000-0000-4000-8000-000000000011'::uuid, v_def_id, 'team-blue', 'Team Blue');
end
$$;

-- Channel 0011's (razorpay, test) payment_accounts row is unique per
-- (channel_id, provider, environment) — a row for exactly that triple may
-- already exist (e.g. l16b_paid_votes_and_widgets.sql, when this file runs
-- after it in a SHARED database such as db:test:l03's curated sequential
-- mode; base_world.sql's own header documents this exact "an earlier test
-- file leaves rows behind" property). Reuse it if present, create it
-- otherwise — never assume a fixed id or a fresh insert will succeed.
insert into payment_accounts (id, channel_id, provider, environment, connected_account_ref, status, created_at, updated_at)
values ('00000000-0000-4000-8000-000000002210', '00000000-0000-4000-8000-000000000011', 'razorpay', 'test', 'acct_prf02s2', 'active', current_timestamp, current_timestamp)
on conflict (channel_id, provider, environment) do nothing;

do $$
declare v_account_id uuid; v_connected_ref text;
begin
  select id, connected_account_ref into v_account_id, v_connected_ref
    from payment_accounts
   where channel_id = '00000000-0000-4000-8000-000000000011' and provider = 'razorpay' and environment = 'test';

  -- Payment 1: ₹3000 tagged to team-red.
  insert into payment_order_intents (id, channel_id, payment_account_id, provider, environment, connected_account_ref, idempotency_key, provider_receipt, provider_order_id, gross_amount_paise, currency, donor_display_name, donor_message, alert_consent, status, expires_at, created_at, updated_at)
  values ('00000000-0000-4000-8000-000000002211', '00000000-0000-4000-8000-000000000011', v_account_id, 'razorpay', 'test', v_connected_ref, 'prf02s2-idem-r1-000001', 'prf02s2-receipt-r1-000001', 'order_prf02s2_r1', 300000, 'INR', 'Riya', '', true, 'paid', current_timestamp + interval '10 minutes', current_timestamp, current_timestamp);
  insert into payments (id, channel_id, provider, provider_payment_id, provider_order_id, gross_amount_paise, currency, status, environment, connected_account_ref, created_at, updated_at)
  values ('00000000-0000-4000-8000-000000002212', '00000000-0000-4000-8000-000000000011', 'razorpay', 'pay_prf02s2_r1', 'order_prf02s2_r1', 300000, 'INR', 'captured', 'test', v_connected_ref, current_timestamp, current_timestamp);

  -- Payment 2: ₹1000 tagged to team-blue.
  insert into payment_order_intents (id, channel_id, payment_account_id, provider, environment, connected_account_ref, idempotency_key, provider_receipt, provider_order_id, gross_amount_paise, currency, donor_display_name, donor_message, alert_consent, status, expires_at, created_at, updated_at)
  values ('00000000-0000-4000-8000-000000002213', '00000000-0000-4000-8000-000000000011', v_account_id, 'razorpay', 'test', v_connected_ref, 'prf02s2-idem-b1-000001', 'prf02s2-receipt-b1-000001', 'order_prf02s2_b1', 100000, 'INR', 'Bala', '', true, 'paid', current_timestamp + interval '10 minutes', current_timestamp, current_timestamp);
  insert into payments (id, channel_id, provider, provider_payment_id, provider_order_id, gross_amount_paise, currency, status, environment, connected_account_ref, created_at, updated_at)
  values ('00000000-0000-4000-8000-000000002214', '00000000-0000-4000-8000-000000000011', 'razorpay', 'pay_prf02s2_b1', 'order_prf02s2_b1', 100000, 'INR', 'captured', 'test', v_connected_ref, current_timestamp, current_timestamp);
end
$$;

do $$
declare v_def_id uuid;
begin
  select id into v_def_id from public.interaction_definitions where channel_id = '00000000-0000-4000-8000-000000000011' and label = 'Tug of war A';
  perform app_private.tag_vote_payment('00000000-0000-4000-8000-000000000011'::uuid, 'test', 'prf02s2-idem-r1-000001', v_def_id, 'team-red');
  perform app_private.tag_vote_payment('00000000-0000-4000-8000-000000000011'::uuid, 'test', 'prf02s2-idem-b1-000001', v_def_id, 'team-blue');
end
$$;

do $$
declare amount_red bigint; amount_blue bigint; resolved_flag boolean; row_count integer;
begin
  select amount_paise into amount_red from app_private.list_overlay_tug_of_war_vote('00000000-0000-4000-8000-000000002220'::uuid, 'prf02s2-overlay-fingerprint') where option_key = 'team-red';
  select amount_paise into amount_blue from app_private.list_overlay_tug_of_war_vote('00000000-0000-4000-8000-000000002220'::uuid, 'prf02s2-overlay-fingerprint') where option_key = 'team-blue';
  if amount_red <> 300000 then raise exception 'expected team-red tally of 300000, got %', amount_red; end if;
  if amount_blue <> 100000 then raise exception 'expected team-blue tally of 100000, got %', amount_blue; end if;

  select distinct resolved into resolved_flag from app_private.list_overlay_tug_of_war_vote('00000000-0000-4000-8000-000000002220'::uuid, 'prf02s2-overlay-fingerprint');
  if resolved_flag then raise exception 'an open vote must never be shown as resolved'; end if;

  -- The free vote and the three-way paid vote must STILL never be
  -- selected now that an eligible vote exists alongside them.
  select count(*) into row_count from app_private.list_overlay_tug_of_war_vote('00000000-0000-4000-8000-000000002220'::uuid, 'prf02s2-overlay-fingerprint');
  if row_count <> 2 then raise exception 'expected exactly 2 tally rows (the one eligible two-sided vote), got %', row_count; end if;
end
$$;

-- THE REFUND TEST: a processed refund reduces the tally on the very next
-- read — the same live-derivation proof l16b_paid_votes_and_widgets.sql
-- carries for the dashboard/standalone-widget reads, reproduced for this
-- new overlay-facing read so it is not assumed to inherit it.
insert into refunds (id, payment_id, provider_refund_id, amount_paise, status, created_at, updated_at)
values ('00000000-0000-4000-8000-000000002215', '00000000-0000-4000-8000-000000002212', 'rfnd_prf02s2_r1', 120000, 'processed', current_timestamp, current_timestamp);

do $$
declare amount_red bigint;
begin
  select amount_paise into amount_red from app_private.list_overlay_tug_of_war_vote('00000000-0000-4000-8000-000000002220'::uuid, 'prf02s2-overlay-fingerprint') where option_key = 'team-red';
  if amount_red <> 180000 then raise exception 'expected team-red tally to net the 120000 refund down to 180000, got %', amount_red; end if;
end
$$;

-- =========================================================================
-- RESOLUTION TIEBREAK: create a SECOND eligible two-sided paid vote,
-- OLDER than "Tug of war A" is not possible (created_at is set at insert
-- time), so instead prove the "prefer open over closed" half directly —
-- close "Tug of war A" and confirm its own tally still surfaces as
-- resolved (0132's header: a result must remain visible after
-- resolution, not vanish), with the winning side named.
-- =========================================================================
do $$
declare v_def_id uuid;
begin
  select id into v_def_id from public.interaction_definitions where channel_id = '00000000-0000-4000-8000-000000000011' and label = 'Tug of war A';
  perform app_private.close_interaction_definition('00000000-0000-4000-8000-000000000011'::uuid, v_def_id);
end
$$;

do $$
declare resolved_flag boolean; winner text;
begin
  select distinct resolved into resolved_flag from app_private.list_overlay_tug_of_war_vote('00000000-0000-4000-8000-000000002220'::uuid, 'prf02s2-overlay-fingerprint');
  if not resolved_flag then raise exception 'a closed vote must surface as resolved, never vanish (the transparency requirement — see 0132''s header)'; end if;
  select distinct resolved_option_key into winner from app_private.list_overlay_tug_of_war_vote('00000000-0000-4000-8000-000000002220'::uuid, 'prf02s2-overlay-fingerprint');
  if winner <> 'team-red' then raise exception 'expected team-red (the higher tally) as the resolved winner, got %', winner; end if;
end
$$;

-- Now add a SECOND eligible two-sided paid vote (open) — it must be
-- preferred over the now-closed first one, per 0132's stated tiebreak.
select app_private.create_interaction_definition(
  '00000000-0000-4000-8000-000000000011'::uuid, 'support_vote', 'Tug of war B', null,
  '00000000-0000-4000-8000-000000002201'::uuid, false, 'none', '{}'::jsonb, '{"votingMode": "paid"}'::jsonb
);
do $$
declare v_def_id uuid;
begin
  select id into v_def_id from public.interaction_definitions where channel_id = '00000000-0000-4000-8000-000000000011' and label = 'Tug of war B';
  perform app_private.create_vote_option('00000000-0000-4000-8000-000000000011'::uuid, v_def_id, 'north', 'North');
  perform app_private.create_vote_option('00000000-0000-4000-8000-000000000011'::uuid, v_def_id, 'south', 'South');
end
$$;

do $$
declare row_count integer; a_label text; b_label text;
begin
  select count(*) into row_count from app_private.list_overlay_tug_of_war_vote('00000000-0000-4000-8000-000000002220'::uuid, 'prf02s2-overlay-fingerprint');
  if row_count <> 2 then raise exception 'expected 2 rows (the newly open vote, preferred over the closed one), got %', row_count; end if;
  select label into a_label from app_private.list_overlay_tug_of_war_vote('00000000-0000-4000-8000-000000002220'::uuid, 'prf02s2-overlay-fingerprint') where option_key = 'north';
  select label into b_label from app_private.list_overlay_tug_of_war_vote('00000000-0000-4000-8000-000000002220'::uuid, 'prf02s2-overlay-fingerprint') where option_key = 'south';
  if a_label is null or b_label is null then raise exception 'an OPEN two-sided paid vote must be preferred over an older-vs-resolution-order but CLOSED one'; end if;
end
$$;

-- =========================================================================
-- OVERLAY AUTH: a bad token returns zero rows, never an error, never data.
-- =========================================================================
do $$
declare row_count integer;
begin
  select count(*) into row_count from app_private.list_overlay_tug_of_war_vote('00000000-0000-4000-8000-000000002220'::uuid, 'wrong-fingerprint');
  if row_count <> 0 then raise exception 'a wrong overlay token must never return tug-of-war vote data'; end if;
end
$$;

-- =========================================================================
-- CROSS-CHANNEL ISOLATION: a channel-0012 overlay session must never see
-- channel-0011's vote, even though both channels are in scope for other
-- tests in this shared base world.
-- =========================================================================
insert into overlay_sessions (id, channel_id, token_fingerprint, expires_at, created_at)
values ('00000000-0000-4000-8000-000000002221', '00000000-0000-4000-8000-000000000012', 'prf02s2-other-channel-fingerprint', current_timestamp + interval '1 hour', current_timestamp);

do $$
declare row_count integer;
begin
  select count(*) into row_count from app_private.list_overlay_tug_of_war_vote('00000000-0000-4000-8000-000000002221'::uuid, 'prf02s2-other-channel-fingerprint');
  if row_count <> 0 then raise exception 'a different channel''s overlay session must never see this channel''s tug-of-war vote'; end if;
end
$$;

select 'prf02_slice2_tug_of_war_vote.sql: all assertions passed' as result;
