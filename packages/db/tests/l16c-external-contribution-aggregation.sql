-- L16c (0117): external-contribution aggregation. Super Chats and other
-- external support count toward goals/challenges/hype mode alongside
-- BharatStudio tips, gated per-target by contribution_source_inclusions
-- (include/exclude only), with the same "progress is never stored" and
-- "a reversal is an observed fact, never our action" properties 0102/0109
-- already proved for real payments/refunds.
--
-- Reuses base_world's channel '...0011' (owner ...0001, admin ...0003,
-- viewer ...0006). Own fixture id block: ...1801 upward (isolated in its
-- own database by run-sql-suite.sh, so no cross-file collision risk).

\set ON_ERROR_STOP on

begin;

insert into channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at)
values ('00000000-0000-4000-8000-000000000011', 1, 'creator', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp)
on conflict (channel_id, version) do nothing;

insert into channel_configs (channel_id, version, values, effective_at, created_at)
values ('00000000-0000-4000-8000-000000000011', 1, '{}'::jsonb, current_timestamp, current_timestamp)
on conflict (channel_id, version) do nothing;

insert into alert_queues (id, channel_id, name, created_at, updated_at)
values ('00000000-0000-4000-8000-000000001801', '00000000-0000-4000-8000-000000000011', 'YouTube Queue', current_timestamp, current_timestamp);

insert into queue_bindings (id, channel_id, queue_id, source_type, source_id, allow_duplicates, priority, created_at)
values ('00000000-0000-4000-8000-000000001802', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000001801', 'youtube', '__channel_default__', true, 10, current_timestamp);

-- =========================================================================
-- GOAL: create as owner, then ingest a Super Chat and prove it moves
-- progress only when included, that a reversal reduces it on the next
-- read, that the union equals the sum of its parts once a real payment is
-- added too, and that idempotent re-ingest never creates a second
-- contribution.
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);
select app_private.create_support_goal(
  '00000000-0000-4000-8000-000000000011'::uuid, 'Union goal', 100000000, 'open', true
);

do $$
declare
  v_goal_id uuid;
  progress bigint;
  contribution_count integer;
  payments_count_before integer;
  payments_count_after integer;
begin
  select id into v_goal_id from public.support_goals where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'Union goal';

  select progress_paise into progress from app_private.get_channel_goal('00000000-0000-4000-8000-000000000011'::uuid, v_goal_id);
  if progress <> 0 then raise exception 'CHECK DOES NOT HOLD: a fresh goal reported nonzero progress (%)', progress; end if;

  select count(*) into payments_count_before from public.payments where channel_id = '00000000-0000-4000-8000-000000000011';

  -- Ingest an INR Super Chat as the least-privilege connector role, exactly
  -- as services/youtube-poller-go would.
  set role bsa_connector_poller;
  perform app_private.record_youtube_alert_event(
    '00000000-0000-4000-8000-000000001810'::uuid,
    '00000000-0000-4000-8000-000000001811'::uuid,
    '00000000-0000-4000-8000-000000000011'::uuid,
    'yt-superchat-1', 'youtube.super_chat', 'UC_viewer_1',
    'youtube-poller:yt-superchat-1', 1,
    '{"displayName":"Viewer","message":"go team","amountMinorUnits":300000,"currency":"INR"}'::jsonb
  );
  reset role;

  -- payments must NEVER be written by this path — the whole point of a
  -- separate ledger (file header, migration 0117).
  select count(*) into payments_count_after from public.payments where channel_id = '00000000-0000-4000-8000-000000000011';
  if payments_count_after <> payments_count_before then
    raise exception 'CHECK DOES NOT HOLD: the youtube ingestion path wrote to public.payments';
  end if;

  select count(*) into contribution_count from public.external_contributions
   where channel_id = '00000000-0000-4000-8000-000000000011' and source_type = 'youtube_superchat' and source_id = 'yt-superchat-1';
  if contribution_count <> 1 then raise exception 'CHECK DOES NOT HOLD: expected exactly one external_contributions row, got %', contribution_count; end if;

  -- Included by default (no override row exists yet): the Super Chat moves
  -- the goal.
  select progress_paise into progress from app_private.get_channel_goal('00000000-0000-4000-8000-000000000011'::uuid, v_goal_id);
  if progress <> 300000 then raise exception 'CHECK DOES NOT HOLD: expected progress 300000 with source included, got %', progress; end if;

  -- Exclude the source: progress must fall back to zero (no payments yet).
  perform app_private.set_contribution_source_inclusion(
    '00000000-0000-4000-8000-000000000011'::uuid, 'goal', v_goal_id, 'youtube_superchat', false
  );
  select progress_paise into progress from app_private.get_channel_goal('00000000-0000-4000-8000-000000000011'::uuid, v_goal_id);
  if progress <> 0 then raise exception 'CHECK DOES NOT HOLD: excluded source still counted toward progress (%)', progress; end if;

  -- Re-include.
  perform app_private.set_contribution_source_inclusion(
    '00000000-0000-4000-8000-000000000011'::uuid, 'goal', v_goal_id, 'youtube_superchat', true
  );
  select progress_paise into progress from app_private.get_channel_goal('00000000-0000-4000-8000-000000000011'::uuid, v_goal_id);
  if progress <> 300000 then raise exception 'CHECK DOES NOT HOLD: re-included source did not restore progress (%)', progress; end if;

  -- Idempotent re-ingest of the identical Super Chat message id: no second
  -- contribution, no change in progress.
  set role bsa_connector_poller;
  perform app_private.record_youtube_alert_event(
    '00000000-0000-4000-8000-000000001812'::uuid, -- different candidate ids prove de-dup keys on
    '00000000-0000-4000-8000-000000001813'::uuid, -- (channel_id, source_type, source_id), not the caller's ids
    '00000000-0000-4000-8000-000000000011'::uuid,
    'yt-superchat-1', 'youtube.super_chat', 'UC_viewer_1',
    'youtube-poller:yt-superchat-1-retry', 1,
    '{"displayName":"Viewer","message":"go team","amountMinorUnits":300000,"currency":"INR"}'::jsonb
  );
  reset role;

  select count(*) into contribution_count from public.external_contributions
   where channel_id = '00000000-0000-4000-8000-000000000011' and source_type = 'youtube_superchat' and source_id = 'yt-superchat-1';
  if contribution_count <> 1 then raise exception 'CHECK DOES NOT HOLD: idempotent re-ingest created a second contribution (count=%)', contribution_count; end if;

  select progress_paise into progress from app_private.get_channel_goal('00000000-0000-4000-8000-000000000011'::uuid, v_goal_id);
  if progress <> 300000 then raise exception 'CHECK DOES NOT HOLD: idempotent re-ingest changed progress to %', progress; end if;

  -- An OBSERVED reversal (never our action — we never call anything that
  -- "issues" one) reduces progress on the very next read, no separate
  -- reconciliation step.
  set role bsa_connector_poller;
  perform app_private.record_external_contribution_reversal(
    '00000000-0000-4000-8000-000000001814'::uuid,
    '00000000-0000-4000-8000-000000000011'::uuid,
    'youtube_superchat', 'yt-superchat-1', 'yt-superchat-1-reversal', 150000, 'viewer disputed with YouTube support'
  );
  reset role;

  select progress_paise into progress from app_private.get_channel_goal('00000000-0000-4000-8000-000000000011'::uuid, v_goal_id);
  if progress <> 150000 then raise exception 'CHECK DOES NOT HOLD: observed reversal did not reduce progress (got %, want 150000)', progress; end if;

  -- Idempotent re-observe of the identical reversal: no double deduction.
  set role bsa_connector_poller;
  perform app_private.record_external_contribution_reversal(
    '00000000-0000-4000-8000-000000001815'::uuid,
    '00000000-0000-4000-8000-000000000011'::uuid,
    'youtube_superchat', 'yt-superchat-1', 'yt-superchat-1-reversal', 150000, 'retried webhook'
  );
  reset role;

  select progress_paise into progress from app_private.get_channel_goal('00000000-0000-4000-8000-000000000011'::uuid, v_goal_id);
  if progress <> 150000 then raise exception 'CHECK DOES NOT HOLD: re-observing the same reversal double-deducted (got %, want 150000)', progress; end if;

  -- UNION: add a real captured payment and prove the total equals the sum
  -- of the two parts computed independently.
  insert into payments (id, channel_id, provider, provider_payment_id, provider_order_id, gross_amount_paise, currency, status, created_at, updated_at)
  values ('00000000-0000-4000-8000-000000001820', '00000000-0000-4000-8000-000000000011', 'razorpay', 'pay_l16c_union', 'order_l16c_union', 200000, 'INR', 'captured', current_timestamp, current_timestamp);

  select progress_paise into progress from app_private.get_channel_goal('00000000-0000-4000-8000-000000000011'::uuid, v_goal_id);
  if progress <> 350000 then raise exception 'CHECK DOES NOT HOLD: union total (payments 200000 + external net 150000) = %, want 350000', progress; end if;
end
$$;

-- =========================================================================
-- CHECK: progress cannot be set directly — no column exists to set, and no
-- role other than the migration owner (via SECURITY DEFINER functions) can
-- write the underlying evidence tables at all.
-- =========================================================================
do $$
begin
  if has_table_privilege('bsa_app', 'public.external_contributions', 'INSERT') then
    raise exception 'CHECK DOES NOT HOLD: bsa_app can write external_contributions directly';
  end if;
  if has_table_privilege('bsa_app', 'public.external_contribution_reversals', 'INSERT') then
    raise exception 'CHECK DOES NOT HOLD: bsa_app can write external_contribution_reversals directly';
  end if;
  if has_table_privilege('bsa_connector_poller', 'public.external_contributions', 'UPDATE') then
    raise exception 'CHECK DOES NOT HOLD: bsa_connector_poller can update external_contributions directly';
  end if;
end
$$;

-- =========================================================================
-- CHECK: a viewer cannot toggle source inclusion for a channel they do not
-- own/administer.
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000000006', false);
do $$
declare v_goal_id uuid;
begin
  select id into v_goal_id from public.support_goals where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'Union goal';
  begin
    perform app_private.set_contribution_source_inclusion(
      '00000000-0000-4000-8000-000000000011'::uuid, 'goal', v_goal_id, 'youtube_superchat', false
    );
    raise exception 'CHECK DOES NOT HOLD: a viewer changed contribution source inclusion';
  exception when others then
    if sqlerrm <> 'not authorized to manage this channel''s contribution sources' then
      raise exception 'unexpected error for viewer source-inclusion write: %', sqlerrm;
    end if;
  end;
end
$$;

-- =========================================================================
-- CHALLENGE and HYPE MODE both run on channel '...0012' (base_world's
-- second channel, owner ...0002), NOT ...0011 — current_timestamp is fixed
-- for the whole transaction in Postgres, so every fixture above on ...0011
-- shares one instant and would otherwise fall inside an unbounded/wide
-- window opened "now" on the same channel, contaminating the union total
-- this section means to check in isolation.
-- =========================================================================
insert into channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at)
values ('00000000-0000-4000-8000-000000000012', 2, 'creator', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp)
on conflict (channel_id, version) do nothing;

insert into channel_configs (channel_id, version, values, effective_at, created_at)
values ('00000000-0000-4000-8000-000000000012', 1, '{}'::jsonb, current_timestamp, current_timestamp)
on conflict (channel_id, version) do nothing;

insert into alert_queues (id, channel_id, name, created_at, updated_at)
values ('00000000-0000-4000-8000-000000001803', '00000000-0000-4000-8000-000000000012', 'YouTube Queue B', current_timestamp, current_timestamp);

insert into queue_bindings (id, channel_id, queue_id, source_type, source_id, allow_duplicates, priority, created_at)
values ('00000000-0000-4000-8000-000000001804', '00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000001803', 'youtube', '__channel_default__', true, 10, current_timestamp);

-- =========================================================================
-- CHALLENGE: same union shape as the goal above, condensed to one
-- included/excluded pair plus the union total, since the derivation is
-- identical code shape to support_goal_progress_paise.
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000000002', false);
select app_private.create_challenge(
  '00000000-0000-4000-8000-000000000012'::uuid, 'Union challenge', null, 'stake', 100000000, true
);

do $$
declare
  v_challenge_id uuid;
  progress bigint;
begin
  select id into v_challenge_id from public.challenges where channel_id = '00000000-0000-4000-8000-000000000012' and title = 'Union challenge';
  perform app_private.transition_challenge('00000000-0000-4000-8000-000000000012'::uuid, v_challenge_id, 'active');

  set role bsa_connector_poller;
  perform app_private.record_youtube_alert_event(
    '00000000-0000-4000-8000-000000001830'::uuid,
    '00000000-0000-4000-8000-000000001831'::uuid,
    '00000000-0000-4000-8000-000000000012'::uuid,
    'yt-superchat-challenge', 'youtube.super_chat', 'UC_viewer_2',
    'youtube-poller:yt-superchat-challenge', 1,
    '{"displayName":"Viewer 2","message":null,"amountMinorUnits":400000,"currency":"INR"}'::jsonb
  );
  reset role;

  select progress_paise into progress from app_private.get_channel_challenge('00000000-0000-4000-8000-000000000012'::uuid, v_challenge_id);
  if progress <> 400000 then raise exception 'CHECK DOES NOT HOLD: challenge union progress (included) = %, want 400000', progress; end if;

  perform app_private.set_contribution_source_inclusion(
    '00000000-0000-4000-8000-000000000012'::uuid, 'challenge', v_challenge_id, 'youtube_superchat', false
  );
  select progress_paise into progress from app_private.get_channel_challenge('00000000-0000-4000-8000-000000000012'::uuid, v_challenge_id);
  if progress <> 0 then raise exception 'CHECK DOES NOT HOLD: excluded source still counted toward challenge progress (%)', progress; end if;
end
$$;

-- =========================================================================
-- HYPE MODE: a THIRD, freshly-created channel ('...0013') — hype mode's
-- window is wide open ([started_at, ends_at], not scoped to a single
-- goal/challenge id) and current_timestamp is fixed for this whole
-- transaction, so reusing ...0012 here would also pick up the challenge
-- section's own Super Chat above. A fresh channel with nothing else on it
-- is the only way to check the union in isolation.
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);

insert into channels (id, owner_user_id, handle, display_name, accepting_tips, public_config_version, created_at, updated_at)
values ('00000000-0000-4000-8000-000000000013', '00000000-0000-4000-8000-000000000001', 'synthetic_c_l16c', 'Synthetic C Channel', true, 1, current_timestamp, current_timestamp);

insert into channel_memberships (channel_id, user_id, role, created_at)
values ('00000000-0000-4000-8000-000000000013', '00000000-0000-4000-8000-000000000001', 'owner', current_timestamp);

insert into alert_queues (id, channel_id, name, created_at, updated_at)
values ('00000000-0000-4000-8000-000000001805', '00000000-0000-4000-8000-000000000013', 'YouTube Queue C', current_timestamp, current_timestamp);

insert into interaction_definitions (
  id, channel_id, interaction_type, label, amount_paise, queue_id, tts_enabled, moderation_rule, visual, config, is_enabled, created_at, updated_at
) values (
  '00000000-0000-4000-8000-000000001840', '00000000-0000-4000-8000-000000000013', 'hype_mode', 'Union hype', null,
  '00000000-0000-4000-8000-000000001805', false, 'none', '{}'::jsonb,
  '{"thresholdPaise": 100000, "decaySeconds": 3600}'::jsonb, true, current_timestamp, current_timestamp
);

insert into hype_mode_activations (id, interaction_definition_id, channel_id, started_at, ends_at, created_at)
values (
  '00000000-0000-4000-8000-000000001841', '00000000-0000-4000-8000-000000001840', '00000000-0000-4000-8000-000000000013',
  current_timestamp - interval '1 minute', current_timestamp + interval '1 hour', current_timestamp
);

do $$
declare
  meter bigint;
begin
  set role bsa_connector_poller;
  perform app_private.record_youtube_alert_event(
    '00000000-0000-4000-8000-000000001850'::uuid,
    '00000000-0000-4000-8000-000000001851'::uuid,
    '00000000-0000-4000-8000-000000000013'::uuid,
    'yt-superchat-hype', 'youtube.super_chat', 'UC_viewer_3',
    'youtube-poller:yt-superchat-hype', 1,
    '{"displayName":"Viewer 3","message":null,"amountMinorUnits":150000,"currency":"INR"}'::jsonb
  );
  reset role;

  select meter_paise into meter from app_private.get_channel_hype_mode('00000000-0000-4000-8000-000000000013'::uuid, '00000000-0000-4000-8000-000000001840'::uuid);
  if meter <> 150000 then raise exception 'CHECK DOES NOT HOLD: hype meter with source included = %, want 150000', meter; end if;

  perform app_private.set_contribution_source_inclusion(
    '00000000-0000-4000-8000-000000000013'::uuid, 'interaction_definition', '00000000-0000-4000-8000-000000001840'::uuid, 'youtube_superchat', false
  );
  select meter_paise into meter from app_private.get_channel_hype_mode('00000000-0000-4000-8000-000000000013'::uuid, '00000000-0000-4000-8000-000000001840'::uuid);
  if meter <> 0 then raise exception 'CHECK DOES NOT HOLD: excluded source still counted toward hype meter (%)', meter; end if;
end
$$;

-- =========================================================================
-- CHECK: a non-INR Super Chat is never converted into a contribution — no
-- fabricated FX rate anywhere in this migration (file header).
-- =========================================================================
do $$
declare
  contribution_count integer;
begin
  set role bsa_connector_poller;
  perform app_private.record_youtube_alert_event(
    '00000000-0000-4000-8000-000000001860'::uuid,
    '00000000-0000-4000-8000-000000001861'::uuid,
    '00000000-0000-4000-8000-000000000011'::uuid,
    'yt-superchat-usd', 'youtube.super_chat', 'UC_viewer_4',
    'youtube-poller:yt-superchat-usd', 1,
    '{"displayName":"Viewer 4","message":null,"amountMinorUnits":500,"currency":"USD"}'::jsonb
  );
  reset role;

  select count(*) into contribution_count from public.external_contributions where source_id = 'yt-superchat-usd';
  if contribution_count <> 0 then raise exception 'CHECK DOES NOT HOLD: a USD Super Chat produced an external_contributions row without any FX conversion basis'; end if;

  -- The alert itself is still recorded, unaffected — this migration never
  -- blocks or drops the alert, only the contribution.
  if not exists (select 1 from public.alert_events where id = '00000000-0000-4000-8000-000000001860') then
    raise exception 'CHECK DOES NOT HOLD: the USD Super Chat''s alert_events row was not written';
  end if;
end
$$;

rollback;
