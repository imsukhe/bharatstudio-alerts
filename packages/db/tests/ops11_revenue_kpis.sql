-- OPS-11 (derivable subset): average tip, repeat-supporter rate, challenge
-- revenue, vote revenue. app_private.get_channel_revenue_kpis is a pure
-- derived read over payments/refunds/creator_supporter_relations/
-- challenges/vote_payment_tags -- no new table, no counter, nothing here
-- is incremented anywhere.
--
-- Proves: (1) a refund moves average tip AND repeat-supporter rate on the
-- very next read, from ONE underlying event, with no counter to correct;
-- (2) a partial refund, and a second refund on an already-refunded
-- payment, both recompute correctly; (3) repeat-supporter rate excludes an
-- anonymous identity once its 30-day TTL (0124) has passed -- both from
-- the numerator and the denominator, per Opus's binding privacy decision;
-- (4) challenge and vote revenue are read through the exact existing
-- derivations (0109's challenge_progress_paise, 0108's vote_payment_tags
-- join chain) and move with a refund the same way; (5) financial amounts
-- are owner/admin only -- an operator/moderator gets no row.
--
-- Uses base_world channel '00000000-0000-4000-8000-000000000011' (owner
-- user 1, admin user 3, operator user 4, moderator user 5, viewer user 6).
-- Own fixture ids: '00000000-0000-4000-8000-0000000a11XX' (unused prefix,
-- verified by grep against every other file in this suite at the time of
-- writing).
\set ON_ERROR_STOP on

select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);

-- ---------------------------------------------------------------------
-- Three supporter identities: two anonymous (one live, one already past
-- its 30-day TTL) and one platform (no TTL).
insert into anonymous_browser_identities (id, token_hash, created_at, expires_at)
values
  ('00000000-0000-4000-8000-0000000a1101', 'a'||repeat('1', 63), current_timestamp - interval '10 days', current_timestamp + interval '20 days'),
  ('00000000-0000-4000-8000-0000000a1102', 'a'||repeat('2', 63), current_timestamp - interval '40 days', current_timestamp - interval '10 days');

insert into viewer_identities (id, kind, anonymous_identity_id)
values
  ('00000000-0000-4000-8000-0000000a1111', 'anonymous', '00000000-0000-4000-8000-0000000a1101'),
  ('00000000-0000-4000-8000-0000000a1112', 'anonymous', '00000000-0000-4000-8000-0000000a1102');

insert into viewer_platform_identities (id, provider, provider_user_id, display_name, created_at)
values ('00000000-0000-4000-8000-0000000a1121', 'youtube', 'UC_ops11_p1', 'OPS11 Platform Supporter', current_timestamp);

insert into viewer_identities (id, kind, platform_identity_id)
values ('00000000-0000-4000-8000-0000000a1122', 'platform', '00000000-0000-4000-8000-0000000a1121');

-- Five real payments: two for the live anonymous identity (A1, repeat),
-- two for the TTL-expired anonymous identity (A2, would also be a
-- repeat if it were counted), one for the platform identity (P1, single).
-- The trigger from 0124 (sync_creator_supporter_relation_from_payment)
-- recomputes creator_supporter_relations on every one of these inserts --
-- nothing here writes to that table directly.
insert into payments (id, channel_id, provider, provider_payment_id, provider_order_id, environment, connected_account_ref, gross_amount_paise, currency, status, viewer_identity_id, created_at, updated_at)
values
  ('00000000-0000-4000-8000-0000000a1131', '00000000-0000-4000-8000-000000000011', 'razorpay', 'pay_ops11_a1_1', 'order_ops11_a1_1', 'test', 'acct_ops11', 200000, 'INR', 'captured', '00000000-0000-4000-8000-0000000a1111', current_timestamp - interval '3 hours', current_timestamp - interval '3 hours'),
  ('00000000-0000-4000-8000-0000000a1132', '00000000-0000-4000-8000-000000000011', 'razorpay', 'pay_ops11_a1_2', 'order_ops11_a1_2', 'test', 'acct_ops11', 300000, 'INR', 'captured', '00000000-0000-4000-8000-0000000a1111', current_timestamp - interval '2 hours 55 minutes', current_timestamp - interval '2 hours 55 minutes'),
  ('00000000-0000-4000-8000-0000000a1133', '00000000-0000-4000-8000-000000000011', 'razorpay', 'pay_ops11_a2_1', 'order_ops11_a2_1', 'test', 'acct_ops11', 200000, 'INR', 'captured', '00000000-0000-4000-8000-0000000a1112', current_timestamp - interval '2 hours 50 minutes', current_timestamp - interval '2 hours 50 minutes'),
  ('00000000-0000-4000-8000-0000000a1134', '00000000-0000-4000-8000-000000000011', 'razorpay', 'pay_ops11_a2_2', 'order_ops11_a2_2', 'test', 'acct_ops11', 300000, 'INR', 'captured', '00000000-0000-4000-8000-0000000a1112', current_timestamp - interval '2 hours 45 minutes', current_timestamp - interval '2 hours 45 minutes'),
  ('00000000-0000-4000-8000-0000000a1135', '00000000-0000-4000-8000-000000000011', 'razorpay', 'pay_ops11_p1_1', 'order_ops11_p1_1', 'test', 'acct_ops11', 100000, 'INR', 'captured', '00000000-0000-4000-8000-0000000a1122', current_timestamp - interval '2 hours 40 minutes', current_timestamp - interval '2 hours 40 minutes');

-- 1. Baseline: five net-positive payments, average = 220000; TTL exclusion
-- already applies -- A2 has two payments (would read as a repeat
-- supporter) but its anonymous identity is already expired, so it must
-- not appear in the population at all.
do $$
declare r record;
begin
  select * into r from app_private.get_channel_revenue_kpis('00000000-0000-4000-8000-000000000011'::uuid, null, null);
  if not found then raise exception 'owner must get a row back'; end if;
  if r.net_tip_count <> 5 or r.total_net_tip_paise <> 1100000 or r.average_net_tip_paise <> 220000 then
    raise exception 'baseline average expected 220000 over 5/1100000, got count=%, total=%, avg=%', r.net_tip_count, r.total_net_tip_paise, r.average_net_tip_paise;
  end if;
  if r.supporter_count <> 2 then
    raise exception 'the TTL-expired anonymous identity (A2) must be excluded from the population -- expected supporter_count=2 (A1 live-anonymous + P1 platform), got %', r.supporter_count;
  end if;
  if r.repeat_supporter_count <> 1 or r.repeat_supporter_rate <> 0.5 then
    raise exception 'expected exactly one repeat supporter (A1) out of two counted, rate 0.5, got count=%, rate=%', r.repeat_supporter_count, r.repeat_supporter_rate;
  end if;
end
$$;

-- 2. Refund end-to-end: a FULL refund on A1's second payment reduces it to
-- net zero. This single event must move BOTH average tip (one fewer
-- net-positive payment) AND repeat-supporter rate (A1 drops from 2 to 1
-- supported payment via 0124's trigger, so is no longer a repeat
-- supporter) -- with no counter anywhere to correct.
insert into refunds (id, payment_id, provider_refund_id, amount_paise, status, created_at, updated_at)
values ('00000000-0000-4000-8000-0000000a1141', '00000000-0000-4000-8000-0000000a1132', 'rfnd_ops11_a1_2', 300000, 'processed', current_timestamp, current_timestamp);
update payments set status = 'refunded', updated_at = current_timestamp where id = '00000000-0000-4000-8000-0000000a1132';

do $$
declare r record;
begin
  select * into r from app_private.get_channel_revenue_kpis('00000000-0000-4000-8000-000000000011'::uuid, null, null);
  if r.net_tip_count <> 4 or r.total_net_tip_paise <> 800000 or r.average_net_tip_paise <> 200000 then
    raise exception 'after the full refund expected count=4/total=800000/avg=200000, got count=%, total=%, avg=%', r.net_tip_count, r.total_net_tip_paise, r.average_net_tip_paise;
  end if;
  if r.repeat_supporter_count <> 0 or r.repeat_supporter_rate <> 0 then
    raise exception 'the SAME refund must also drop A1 out of the repeat-supporter set (0124''s trigger recomputes tip_count net of refunds) -- expected repeat_supporter_count=0/rate=0, got count=%, rate=%', r.repeat_supporter_count, r.repeat_supporter_rate;
  end if;
  if r.supporter_count <> 2 then
    raise exception 'supporter_count itself must be unaffected by the refund (A1 is still a supporter, just no longer a repeat one), got %', r.supporter_count;
  end if;
end
$$;

-- 3. Partial refund, then a SECOND refund on the already-refunded
-- payment. Average tip must recompute correctly both times, with no
-- accumulation error. (In production every refund-related webhook
-- re-touches payments.status even when the value does not change --
-- 0014's sync_refund_webhood_status always issues the UPDATE -- so this
-- file does the same to fire 0124's trigger identically.)
insert into refunds (id, payment_id, provider_refund_id, amount_paise, status, created_at, updated_at)
values ('00000000-0000-4000-8000-0000000a1142', '00000000-0000-4000-8000-0000000a1135', 'rfnd_ops11_p1_1a', 40000, 'processed', current_timestamp, current_timestamp);
update payments set status = 'partially_refunded', updated_at = current_timestamp where id = '00000000-0000-4000-8000-0000000a1135';

do $$
declare r record;
begin
  select * into r from app_private.get_channel_revenue_kpis('00000000-0000-4000-8000-000000000011'::uuid, null, null);
  if r.net_tip_count <> 4 or r.total_net_tip_paise <> 760000 or r.average_net_tip_paise <> 190000 then
    raise exception 'after the partial refund expected count=4/total=760000/avg=190000, got count=%, total=%, avg=%', r.net_tip_count, r.total_net_tip_paise, r.average_net_tip_paise;
  end if;
end
$$;

insert into refunds (id, payment_id, provider_refund_id, amount_paise, status, created_at, updated_at)
values ('00000000-0000-4000-8000-0000000a1143', '00000000-0000-4000-8000-0000000a1135', 'rfnd_ops11_p1_1b', 20000, 'processed', current_timestamp, current_timestamp);
update payments set status = 'partially_refunded', updated_at = current_timestamp where id = '00000000-0000-4000-8000-0000000a1135';

do $$
declare r record;
begin
  select * into r from app_private.get_channel_revenue_kpis('00000000-0000-4000-8000-000000000011'::uuid, null, null);
  if r.net_tip_count <> 4 or r.total_net_tip_paise <> 740000 or r.average_net_tip_paise <> 185000 then
    raise exception 'after a SECOND refund on the same payment expected count=4/total=740000/avg=185000, got count=%, total=%, avg=%', r.net_tip_count, r.total_net_tip_paise, r.average_net_tip_paise;
  end if;
end
$$;

-- 4. Challenge revenue: reuses 0109's own challenge_progress_paise
-- unchanged -- a windowed sum over this channel's payments during the
-- challenge's active window, nothing new attributed.
insert into challenges (id, channel_id, created_by_user_id, title, challenge_kind, target_amount_paise, state, is_public, started_at, created_at, updated_at)
values ('00000000-0000-4000-8000-0000000a1151', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001', 'OPS11 challenge', 'bounty', 1000000, 'active', true, current_timestamp - interval '10 minutes', current_timestamp - interval '10 minutes', current_timestamp - interval '10 minutes');

insert into payments (id, channel_id, provider, provider_payment_id, provider_order_id, environment, connected_account_ref, gross_amount_paise, currency, status, created_at, updated_at)
values ('00000000-0000-4000-8000-0000000a1152', '00000000-0000-4000-8000-000000000011', 'razorpay', 'pay_ops11_challenge', 'order_ops11_challenge', 'test', 'acct_ops11', 150000, 'INR', 'captured', current_timestamp - interval '5 minutes', current_timestamp - interval '5 minutes');

do $$
declare r record;
begin
  select * into r from app_private.get_channel_revenue_kpis('00000000-0000-4000-8000-000000000011'::uuid, null, null);
  if r.challenge_revenue_paise <> 150000 then
    raise exception 'challenge revenue expected 150000 (only the payment inside the challenge''s active window), got %', r.challenge_revenue_paise;
  end if;
end
$$;

-- 5. Vote revenue: the exact 0108 join chain (vote_payment_tags ->
-- payment_order_intents -> payments), aggregated channel-wide. A refund
-- on the tagged payment must move it too.
insert into alert_queues (id, channel_id, name, is_paused, created_at, updated_at)
values ('00000000-0000-4000-8000-0000000a1161', '00000000-0000-4000-8000-000000000011', 'OPS11 queue', false, current_timestamp, current_timestamp);

insert into interaction_definitions (id, channel_id, interaction_type, label, amount_paise, queue_id, tts_enabled, moderation_rule, visual, config, is_enabled, closed_at, created_at, updated_at)
values ('00000000-0000-4000-8000-0000000a1162', '00000000-0000-4000-8000-000000000011', 'support_vote', 'OPS11 paid poll', null, '00000000-0000-4000-8000-0000000a1161', false, 'none', '{}'::jsonb, '{"votingMode":"paid"}'::jsonb, true, null, current_timestamp, current_timestamp);

insert into interaction_vote_options (id, interaction_definition_id, option_key, label, created_at)
values ('00000000-0000-4000-8000-0000000a1163', '00000000-0000-4000-8000-0000000a1162', 'a', 'Option A', current_timestamp);

insert into payment_accounts (id, channel_id, provider, environment, connected_account_ref, status, created_at, updated_at)
values ('00000000-0000-4000-8000-0000000a1164', '00000000-0000-4000-8000-000000000011', 'razorpay', 'test', 'acct_ops11_vote', 'active', current_timestamp, current_timestamp);

insert into payment_order_intents (id, channel_id, payment_account_id, provider, environment, connected_account_ref, idempotency_key, provider_receipt, provider_order_id, gross_amount_paise, currency, status, expires_at, created_at, updated_at)
values ('00000000-0000-4000-8000-0000000a1165', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-0000000a1164', 'razorpay', 'test', 'acct_ops11_vote', 'idem_ops11_vote_1', 'receipt_ops11_vote_1', 'order_ops11_vote_1', 250000, 'INR', 'paid', current_timestamp - interval '10 minutes', current_timestamp - interval '20 minutes', current_timestamp);

select app_private.tag_vote_payment('00000000-0000-4000-8000-000000000011'::uuid, 'test', 'idem_ops11_vote_1', '00000000-0000-4000-8000-0000000a1162'::uuid, 'a');

insert into payments (id, channel_id, provider, provider_payment_id, provider_order_id, environment, connected_account_ref, gross_amount_paise, currency, status, created_at, updated_at)
values ('00000000-0000-4000-8000-0000000a1166', '00000000-0000-4000-8000-000000000011', 'razorpay', 'pay_ops11_vote_1', 'order_ops11_vote_1', 'test', 'acct_ops11_vote', 250000, 'INR', 'captured', current_timestamp - interval '15 minutes', current_timestamp - interval '15 minutes');

do $$
declare r record;
begin
  select * into r from app_private.get_channel_revenue_kpis('00000000-0000-4000-8000-000000000011'::uuid, null, null);
  if r.vote_revenue_paise <> 250000 then
    raise exception 'vote revenue expected 250000, got %', r.vote_revenue_paise;
  end if;
end
$$;

-- A refund on the tagged vote payment moves vote revenue too -- same
-- "derive, never store" shape as everything above.
insert into refunds (id, payment_id, provider_refund_id, amount_paise, status, created_at, updated_at)
values ('00000000-0000-4000-8000-0000000a1167', '00000000-0000-4000-8000-0000000a1166', 'rfnd_ops11_vote_1', 50000, 'processed', current_timestamp, current_timestamp);
update payments set status = 'partially_refunded', updated_at = current_timestamp where id = '00000000-0000-4000-8000-0000000a1166';

do $$
declare r record;
begin
  select * into r from app_private.get_channel_revenue_kpis('00000000-0000-4000-8000-000000000011'::uuid, null, null);
  if r.vote_revenue_paise <> 200000 then
    raise exception 'after a 50000-paise refund on the tagged vote payment, vote revenue expected 200000, got %', r.vote_revenue_paise;
  end if;
end
$$;

-- 6. Financial amounts are owner/admin only. An operator or a moderator
-- gets no row back -- not an error, not a zeroed-out row (which would
-- itself leak "how many rows exist"), matching list_channel_payments'
-- (0071) own posture.
select set_config('app.user_id', '00000000-0000-4000-8000-000000000004', false);
do $$
declare r record;
begin
  select * into r from app_private.get_channel_revenue_kpis('00000000-0000-4000-8000-000000000011'::uuid, null, null);
  if found then raise exception 'an operator must not receive revenue-KPI amounts'; end if;
end
$$;

select set_config('app.user_id', '00000000-0000-4000-8000-000000000005', false);
do $$
declare r record;
begin
  select * into r from app_private.get_channel_revenue_kpis('00000000-0000-4000-8000-000000000011'::uuid, null, null);
  if found then raise exception 'a moderator must not receive revenue-KPI amounts'; end if;
end
$$;

-- An admin (not just the owner) is allowed, per the same role rule as the
-- payment ledger.
select set_config('app.user_id', '00000000-0000-4000-8000-000000000003', false);
do $$
declare r record;
begin
  select * into r from app_private.get_channel_revenue_kpis('00000000-0000-4000-8000-000000000011'::uuid, null, null);
  if not found then raise exception 'an admin must receive revenue-KPI amounts'; end if;
end
$$;
