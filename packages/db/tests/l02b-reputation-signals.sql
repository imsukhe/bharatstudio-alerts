-- L02b: supporter reputation signals -> score -> action (packages/db/migrations/0120).
--
-- Own fixture ids: 00000000-...-000000001701 upward (next free block per the
-- registry in fixtures/00_base_world.sql). Reuses base_world's channels
-- '...0011' (owner user '...0001') and '...0012' (owner user '...0002') as
-- two distinct creators.
--
-- psql does not substitute `:'variables'` inside a dollar-quoted (do
-- $$...$$) body (see l14_viewer_identity.sql's own note on this) — every
-- id needed inside a do block is first pushed into a session GUC via
-- set_config and read back with current_setting()::uuid.
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------
-- Fixture: two viewer accounts. Viewer A supports BOTH base-world channels
-- (a real cross-creator supporter), viewer B supports only channel 0012 and
-- is scored purely through Super Chat signals (no refund is ever possible
-- for her).
-- ---------------------------------------------------------------------
select viewer_account_id, viewer_identity_id
  from app_private.create_viewer_account('00000000-0000-4000-8000-000000001701', 'l02b-viewer-a@example.com', repeat('x', 32), 'L02b Viewer A')
\gset l02b_viewer_a_

select viewer_account_id, viewer_identity_id
  from app_private.create_viewer_account('00000000-0000-4000-8000-000000001702', 'l02b-viewer-b@example.com', repeat('y', 32), 'L02b Viewer B')
\gset l02b_viewer_b_

select set_config('l02b.viewer_a_identity', :'l02b_viewer_a_viewer_identity_id', false);
select set_config('l02b.viewer_a_account', :'l02b_viewer_a_viewer_account_id', false);
select set_config('l02b.viewer_b_identity', :'l02b_viewer_b_viewer_identity_id', false);

insert into creator_supporter_relations (channel_id, viewer_identity_id, first_supported_at, last_supported_at, lifetime_amount_paise, tip_count, challenge_count, member_state)
values
  ('00000000-0000-4000-8000-000000000011', :'l02b_viewer_a_viewer_identity_id', current_timestamp - interval '10 days', current_timestamp, 500000, 3, 0, 'active'),
  ('00000000-0000-4000-8000-000000000012', :'l02b_viewer_a_viewer_identity_id', current_timestamp - interval '5 days', current_timestamp, 200000, 1, 0, 'active'),
  ('00000000-0000-4000-8000-000000000012', :'l02b_viewer_b_viewer_identity_id', current_timestamp - interval '2 days', current_timestamp, 50000, 1, 0, 'none');

-- A captured BharatStudio tip from viewer A on channel 0011, refunded.
insert into payments (id, channel_id, provider, provider_payment_id, provider_order_id, gross_amount_paise, currency, status, created_at, updated_at, viewer_identity_id)
values ('00000000-0000-4000-8000-000000001710', '00000000-0000-4000-8000-000000000011', 'razorpay', 'l02b-pay-1710', 'l02b-order-1710', 150000, 'INR', 'refunded', current_timestamp - interval '9 days', current_timestamp - interval '1 days', :'l02b_viewer_a_viewer_identity_id');

insert into refunds (id, payment_id, provider_refund_id, amount_paise, status, created_at, updated_at)
values ('00000000-0000-4000-8000-000000001711', '00000000-0000-4000-8000-000000001710', 'l02b-refund-1711', 150000, 'processed', current_timestamp - interval '1 days', current_timestamp - interval '1 days');

-- =======================================================================
-- CHECK 1: a refund signal is recorded (derived live) for BharatStudio tips
-- and structurally cannot exist for Super Chat.
-- =======================================================================
do $$
declare
  refund_rows integer;
begin
  select count(*) into refund_rows
    from app_private.reputation_signal_evidence(current_setting('l02b.viewer_a_identity')::uuid)
   where source = 'bharatstudio_tip' and signal_type = 'refund';
  if refund_rows <> 1 then
    raise exception 'CHECK1: expected exactly one derived bharatstudio_tip refund signal, saw %', refund_rows;
  end if;
end
$$;

-- No refund/chargeback signal can ever be attached to a super_chat row: the
-- writer function refuses it...
do $$
declare
  viewer_a_identity uuid := current_setting('l02b.viewer_a_identity')::uuid;
begin
  begin
    perform app_private.record_reputation_signal(viewer_a_identity, '00000000-0000-4000-8000-000000000012', 'super_chat', 'chargeback', 3, current_timestamp, '{}'::jsonb);
    raise exception 'CHECK1b DOES NOT HOLD: a chargeback signal was accepted for super_chat';
  exception when others then
    if sqlerrm not like '%only available for bharatstudio_tip%' then raise; end if;
  end;
  begin
    perform app_private.record_reputation_signal(viewer_a_identity, '00000000-0000-4000-8000-000000000012', 'super_chat', 'refund', 3, current_timestamp, '{}'::jsonb);
    raise exception 'CHECK1c DOES NOT HOLD: a refund row was accepted into reputation_signal_events';
  exception when others then
    if sqlerrm not like '%never recorded%' then raise; end if;
  end;
end
$$;

-- ...and even bypassing the function, the TABLE ITSELF refuses it (defence
-- in depth: the constraint, not just application discipline).
do $$
declare
  viewer_a_identity uuid := current_setting('l02b.viewer_a_identity')::uuid;
begin
  begin
    insert into reputation_signal_events (id, viewer_identity_id, channel_id, source, signal_type, severity, occurred_at)
    values (gen_random_uuid(), viewer_a_identity, '00000000-0000-4000-8000-000000000012', 'super_chat', 'chargeback', 3, current_timestamp);
    raise exception 'CHECK1d DOES NOT HOLD: table CHECK did not stop a super_chat chargeback row';
  exception when check_violation then
    null;
  end;
end
$$;

-- Velocity IS available on both sources (the one signal both can produce).
select app_private.record_reputation_signal(:'l02b_viewer_b_viewer_identity_id', '00000000-0000-4000-8000-000000000012', 'super_chat', 'velocity_spike', 2, current_timestamp - interval '1 hours', '{"messages_per_minute": 40}'::jsonb);
select app_private.record_reputation_signal(:'l02b_viewer_b_viewer_identity_id', '00000000-0000-4000-8000-000000000012', 'super_chat', 'content_moderation_strike', 2, current_timestamp - interval '2 hours', '{"reason": "spam_link"}'::jsonb);

-- =======================================================================
-- CHECK 2: the score derives live and cannot be set directly.
-- =======================================================================
do $$
declare
  viewer_a_identity uuid := current_setting('l02b.viewer_a_identity')::uuid;
  score_before integer;
  score_after integer;
  score_after_reversal integer;
  score_column_count integer;
begin
  -- No column named anything like a score exists anywhere: the only way to
  -- change it is through the underlying signal/payment history.
  select count(*) into score_column_count
    from information_schema.columns
   where table_schema in ('public', 'app_private')
     and column_name ilike '%score%';
  if score_column_count <> 0 then
    raise exception 'CHECK2: found % column(s) literally named like a score — the score must never be a stored/mutable column', score_column_count;
  end if;

  -- Live-recompute proof: mark viewer A's processed refund as reversed
  -- (an ordinary payments-domain write, not a "reputation" write) and watch
  -- the score drop with no un-scoring step of any kind.
  score_before := app_private.reputation_score(viewer_a_identity);
  if score_before < 60 then
    raise exception 'CHECK2: expected viewer A''s score to already reflect the processed refund (>=60), saw %', score_before;
  end if;

  update refunds set status = 'reversed', updated_at = current_timestamp where id = '00000000-0000-4000-8000-000000001711';

  score_after_reversal := app_private.reputation_score(viewer_a_identity);
  if score_after_reversal <> 0 then
    raise exception 'CHECK2: reversing the refund must zero the derived score with no un-scoring step, saw %', score_after_reversal;
  end if;

  -- Restore for the later checks below (this file's remaining checks
  -- assert on the refunded/flagged state).
  update refunds set status = 'processed', updated_at = current_timestamp where id = '00000000-0000-4000-8000-000000001711';
  score_after := app_private.reputation_score(viewer_a_identity);
  if score_after < 60 then
    raise exception 'CHECK2: restoring the refund must restore the score with no explicit write, saw %', score_after;
  end if;
end
$$;

-- =======================================================================
-- CHECK 3 / 4: cross-creator boundary + flagged verdict without evidence.
-- Run AS THE REAL APP ROLE (bsa_app), not superuser, so the grant boundary
-- is actually proven (see l16_security_boundary.sql's own framing).
-- =======================================================================
begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000000002', true); -- owner of channel 0012 only

do $$
declare
  viewer_a_identity uuid := current_setting('l02b.viewer_a_identity')::uuid;
  verdict_row record;
  key_count integer;
begin
  select * into verdict_row
    from app_private.get_supporter_reputation_verdict('00000000-0000-4000-8000-000000000012', viewer_a_identity);

  if verdict_row.verdict is distinct from 'flagged' then
    raise exception 'CHECK3 DOES NOT HOLD: channel 0012''s creator must see viewer A flagged (the refund happened on channel 0011 — this is the cross-creator signal the SYSTEM is allowed to use), saw %', verdict_row.verdict;
  end if;
  if verdict_row.recommended_action is distinct from 'review_before_payout' then
    raise exception 'CHECK4: expected a recommended action alongside the flagged verdict, saw %', verdict_row.recommended_action;
  end if;

  -- Exact key set: viewer_identity_id, verdict, recommended_action. Nothing
  -- else — no source, no channel_id, no signal_type, no evidence.
  select count(*) into key_count from jsonb_object_keys(to_jsonb(verdict_row)) k;
  if key_count <> 3 then
    raise exception 'CHECK3 DOES NOT HOLD: creator response must have exactly 3 keys, saw %', key_count;
  end if;
  if not (to_jsonb(verdict_row) ?& array['viewer_identity_id', 'verdict', 'recommended_action']) then
    raise exception 'CHECK3 DOES NOT HOLD: creator response key set is not exactly {viewer_identity_id, verdict, recommended_action}: %', to_jsonb(verdict_row);
  end if;
end
$$;

-- CHECK 4b: the creator role cannot reach the evidence functions at all —
-- "flagged" is visible, the refund/chargeback/signal rows behind it are not.
do $$
declare
  viewer_a_identity uuid := current_setting('l02b.viewer_a_identity')::uuid;
begin
  begin
    perform app_private.reputation_signal_evidence(viewer_a_identity);
    raise exception 'CHECK4 DOES NOT HOLD: bsa_app could call reputation_signal_evidence directly';
  exception when insufficient_privilege then
    null;
  end;
  begin
    perform app_private.reputation_score(viewer_a_identity);
    raise exception 'CHECK4 DOES NOT HOLD: bsa_app could call reputation_score directly';
  exception when insufficient_privilege then
    null;
  end;
end
$$;

-- CHECK 3b: channel 0012's creator gets nothing at all for a viewer who has
-- never supported channel 0012 (the function's own scoping, not RLS, is
-- what stops the fishing attempt — proven here with a viewer who supports
-- neither channel).
do $$
declare
  row_count integer;
begin
  select count(*) into row_count
    from app_private.get_supporter_reputation_verdict('00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000001'); -- app_users id, not even a viewer_identity_id
  if row_count <> 0 then
    raise exception 'CHECK3b DOES NOT HOLD: fishing for a non-supporter must return nothing, saw % rows', row_count;
  end if;
end
$$;
commit;

-- =======================================================================
-- CHECK 5: deletion interacts with the score explicitly (retained, not
-- erased — see 0120's header for why this is left an OPEN question).
-- =======================================================================
do $$
declare
  viewer_a_identity uuid := current_setting('l02b.viewer_a_identity')::uuid;
  viewer_a_account uuid := current_setting('l02b.viewer_a_account')::uuid;
  score_before_deletion integer;
  score_after_deletion integer;
  erasure jsonb;
  legal_disposition_open boolean;
begin
  score_before_deletion := app_private.reputation_score(viewer_a_identity);

  perform set_config('app.viewer_id', viewer_a_account::text, false);
  select app_private.request_viewer_account_deletion(viewer_a_account) into erasure;

  select (erasure ->> 'legalDispositionOpen')::boolean into legal_disposition_open;
  if legal_disposition_open is not true then
    raise exception 'CHECK5: legalDispositionOpen must remain true after this migration';
  end if;
  if not exists (select 1 from jsonb_array_elements_text(erasure -> 'retained') r where r like '%reputation_signal_events%') then
    raise exception 'CHECK5 DOES NOT HOLD: erasure_record must explicitly mention reputation retention, saw %', erasure -> 'retained';
  end if;

  score_after_deletion := app_private.reputation_score(viewer_a_identity);
  if score_after_deletion <> score_before_deletion then
    raise exception 'CHECK5 DOES NOT HOLD: this migration''s explicit (not silent) behaviour is retention — score must be unchanged after deletion, was % now %', score_before_deletion, score_after_deletion;
  end if;
end
$$;

select 'l02b-reputation-signals: all checks passed' as result;
