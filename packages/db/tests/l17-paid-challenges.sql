-- L17 (0109): paid challenges — progress derivation from real payments,
-- refund-reduces-progress with no code path of ours, state-machine edge
-- validation, tier entitlement gate, and role gate on transition.
-- Uses base_world channel '...0011' (owner 1/admin 3/operator 4/moderator
-- 5/viewer 6) and channel '...0012' (owner 2, kept at 'free' tier for the
-- entitlement-gate check). Own fixture ids: ...1701 upward.
--
-- Challenges are looked up by their (unique-per-file) title inside each do
-- block rather than captured via psql's \gset — psql does NOT interpolate
-- `:'var'` inside a dollar-quoted (`do $$ ... $$`) body (see
-- goal_progress_and_refund.sql's file header for the confirmed repro), and
-- create_challenge generates its own id internally (gen_random_uuid()), so
-- there is no fixed literal id to hardcode the way other files do for their
-- own pre-assigned fixture ids.
\set ON_ERROR_STOP on

insert into channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at)
values
  ('00000000-0000-4000-8000-000000000011', 1, 'creator', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000000012', 1, 'free', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp)
on conflict (channel_id, version) do nothing;

-- =========================================================================
-- CHECK: an unentitled (free) tier cannot create a challenge at all.
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000000002', false);
do $$
begin
  begin
    perform app_private.create_challenge(
      '00000000-0000-4000-8000-000000000012'::uuid, 'Free tier attempt', null, 'stake', 100000, true
    );
    raise exception 'CHECK DOES NOT HOLD: a free-tier channel created a challenge';
  exception when others then
    if sqlerrm <> 'challenge limit reached for the channel''s current tier' then
      raise exception 'unexpected error for free-tier create: %', sqlerrm;
    end if;
  end;
end
$$;

-- =========================================================================
-- Create a real challenge on the entitled (creator-tier) channel, owner.
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);
select app_private.create_challenge(
  '00000000-0000-4000-8000-000000000011'::uuid, 'Shave my head at target', 'If we hit the target, it happens live.', 'stake', 500000, true
);

-- Progress on a draft (not-yet-started) challenge is always zero, even
-- with unrelated payments sitting in the channel.
insert into payments (id, channel_id, provider, provider_payment_id, provider_order_id, gross_amount_paise, currency, status, created_at, updated_at)
values ('00000000-0000-4000-8000-000000001701', '00000000-0000-4000-8000-000000000011', 'razorpay', 'pay_l17_predraft', 'order_l17_predraft', 900000, 'INR', 'captured', current_timestamp, current_timestamp);

do $$
declare v_challenge_id uuid; progress bigint;
begin
  select id into v_challenge_id from public.challenges where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'Shave my head at target';
  select progress_paise into progress from app_private.get_channel_challenge('00000000-0000-4000-8000-000000000011'::uuid, v_challenge_id);
  if progress <> 0 then raise exception 'CHECK DOES NOT HOLD: a draft challenge reported nonzero progress (%)', progress; end if;
end
$$;

-- =========================================================================
-- CHECK: a viewer/moderator cannot transition a challenge.
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000000006', false);
do $$
declare v_challenge_id uuid;
begin
  select id into v_challenge_id from public.challenges where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'Shave my head at target';
  begin
    perform app_private.transition_challenge('00000000-0000-4000-8000-000000000011'::uuid, v_challenge_id, 'active');
    raise exception 'CHECK DOES NOT HOLD: a viewer transitioned a challenge';
  exception when others then
    if sqlerrm <> 'not authorized to manage this channel''s challenges' then
      raise exception 'unexpected error for viewer transition: %', sqlerrm;
    end if;
  end;
end
$$;

select set_config('app.user_id', '00000000-0000-4000-8000-000000000005', false);
do $$
declare v_challenge_id uuid;
begin
  select id into v_challenge_id from public.challenges where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'Shave my head at target';
  begin
    perform app_private.transition_challenge('00000000-0000-4000-8000-000000000011'::uuid, v_challenge_id, 'active');
    raise exception 'CHECK DOES NOT HOLD: a moderator transitioned a challenge';
  exception when others then
    if sqlerrm <> 'not authorized to manage this channel''s challenges' then
      raise exception 'unexpected error for moderator transition: %', sqlerrm;
    end if;
  end;
end
$$;

-- =========================================================================
-- CHECK: invalid state transitions are rejected (draft -> succeeded/failed
-- skips activation entirely).
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);
do $$
declare v_challenge_id uuid;
begin
  select id into v_challenge_id from public.challenges where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'Shave my head at target';
  begin
    perform app_private.transition_challenge('00000000-0000-4000-8000-000000000011'::uuid, v_challenge_id, 'succeeded');
    raise exception 'CHECK DOES NOT HOLD: draft -> succeeded was accepted';
  exception when others then
    if sqlerrm !~ 'invalid challenge state transition' then raise exception 'unexpected error: %', sqlerrm; end if;
  end;
end
$$;

-- =========================================================================
-- Owner activates the challenge (draft -> active), then contributions
-- (real payments) accrue as progress.
-- =========================================================================
do $$
declare v_challenge_id uuid; current_state text;
begin
  select id into v_challenge_id from public.challenges where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'Shave my head at target';
  perform app_private.transition_challenge('00000000-0000-4000-8000-000000000011'::uuid, v_challenge_id, 'active');
  select state into current_state from app_private.get_channel_challenge('00000000-0000-4000-8000-000000000011'::uuid, v_challenge_id);
  if current_state <> 'active' then raise exception 'expected active state, got %', current_state; end if;
end
$$;

insert into payments (id, channel_id, provider, provider_payment_id, provider_order_id, gross_amount_paise, currency, status, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000001702', '00000000-0000-4000-8000-000000000011', 'razorpay', 'pay_l17_contrib_1', 'order_l17_contrib_1', 300000, 'INR', 'captured', current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000001703', '00000000-0000-4000-8000-000000000011', 'razorpay', 'pay_l17_contrib_2', 'order_l17_contrib_2', 250000, 'INR', 'captured', current_timestamp, current_timestamp);

-- CHECK: contributions derive from real payments — no direct way to set
-- progress exists; this is the only way progress ever moved.
do $$
declare v_challenge_id uuid; progress bigint;
begin
  select id into v_challenge_id from public.challenges where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'Shave my head at target';
  select progress_paise into progress from app_private.get_channel_challenge('00000000-0000-4000-8000-000000000011'::uuid, v_challenge_id);
  if progress <> 550000 then raise exception 'CHECK DOES NOT HOLD: expected progress 550000 from two real payments, got %', progress; end if;
end
$$;

-- CHECK: a provider-issued refund reduces progress with no code path of
-- ours involved — inserting a refunds row directly (exactly what the
-- webhook reconciler does when a creator refunds through their own
-- provider dashboard) is the entire mechanism.
update payments set status = 'refunded', updated_at = current_timestamp where id = '00000000-0000-4000-8000-000000001703';
insert into refunds (id, payment_id, provider_refund_id, amount_paise, status, created_at, updated_at)
values ('00000000-0000-4000-8000-000000001704', '00000000-0000-4000-8000-000000001703', 'rfnd_l17_1', 250000, 'processed', current_timestamp, current_timestamp);

do $$
declare v_challenge_id uuid; progress bigint;
begin
  select id into v_challenge_id from public.challenges where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'Shave my head at target';
  select progress_paise into progress from app_private.get_channel_challenge('00000000-0000-4000-8000-000000000011'::uuid, v_challenge_id);
  if progress <> 300000 then raise exception 'CHECK DOES NOT HOLD: refund did not reduce progress (expected 300000, got %)', progress; end if;
end
$$;

-- =========================================================================
-- CHECK: active -> draft is not a valid edge (no going back).
-- =========================================================================
do $$
declare v_challenge_id uuid;
begin
  select id into v_challenge_id from public.challenges where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'Shave my head at target';
  begin
    perform app_private.transition_challenge('00000000-0000-4000-8000-000000000011'::uuid, v_challenge_id, 'draft');
    raise exception 'CHECK DOES NOT HOLD: active -> draft was accepted';
  exception when others then
    if sqlerrm !~ 'invalid challenge state transition' then raise exception 'unexpected error: %', sqlerrm; end if;
  end;
end
$$;

-- =========================================================================
-- Owner fails the challenge (target not reached). Money already went to
-- the creator via the underlying tips — this migration builds no refund
-- path, so failure is purely a lifecycle write.
-- =========================================================================
do $$
declare v_challenge_id uuid; current_state text; ended timestamptz;
begin
  select id into v_challenge_id from public.challenges where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'Shave my head at target';
  perform app_private.transition_challenge('00000000-0000-4000-8000-000000000011'::uuid, v_challenge_id, 'failed');
  select state, ended_at into current_state, ended from app_private.get_channel_challenge('00000000-0000-4000-8000-000000000011'::uuid, v_challenge_id);
  if current_state <> 'failed' then raise exception 'expected failed state, got %', current_state; end if;
  if ended is null then raise exception 'CHECK DOES NOT HOLD: a terminal challenge has no ended_at'; end if;
end
$$;

-- CHECK: a terminal state has no further valid transition.
do $$
declare v_challenge_id uuid;
begin
  select id into v_challenge_id from public.challenges where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'Shave my head at target';
  begin
    perform app_private.transition_challenge('00000000-0000-4000-8000-000000000011'::uuid, v_challenge_id, 'active');
    raise exception 'CHECK DOES NOT HOLD: failed -> active was accepted';
  exception when others then
    if sqlerrm !~ 'invalid challenge state transition' then raise exception 'unexpected error: %', sqlerrm; end if;
  end;
end
$$;

-- CHECK: the lifecycle audit trail is append-only and complete — two real
-- transitions recorded (draft->active, active->failed); the rejected
-- attempts above never touched the table.
do $$
declare v_challenge_id uuid; event_count integer;
begin
  select id into v_challenge_id from public.challenges where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'Shave my head at target';
  select count(*) into event_count from challenge_status_events where challenge_id = v_challenge_id;
  if event_count <> 2 then raise exception 'CHECK DOES NOT HOLD: expected 2 status events, got %', event_count; end if;
end
$$;

-- =========================================================================
-- CHECK: bsa_app has no direct table grant on challenges or
-- challenge_status_events — every access path is a security-definer
-- function, same shape as l16_security_boundary.sql's proof for
-- support_goals.
-- =========================================================================
begin;
set local role bsa_app;
do $$
begin
  begin
    perform 1 from challenges limit 1;
    raise exception 'CHECK DOES NOT HOLD: bsa_app has a direct table grant on challenges';
  exception
    when insufficient_privilege then null;
  end;
  begin
    perform 1 from challenge_status_events limit 1;
    raise exception 'CHECK DOES NOT HOLD: bsa_app has a direct table grant on challenge_status_events';
  exception
    when insufficient_privilege then null;
  end;
end
$$;
commit;

-- =========================================================================
-- Overlay widget read: create a fresh active+public challenge and an
-- overlay session, then read it through list_overlay_challenge exactly as
-- the widget route does.
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);
select app_private.create_challenge(
  '00000000-0000-4000-8000-000000000011'::uuid, 'Overlay bounty', null, 'bounty', 200000, true
);

do $$
declare v_challenge_id uuid;
begin
  select id into v_challenge_id from public.challenges where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'Overlay bounty';
  perform app_private.transition_challenge('00000000-0000-4000-8000-000000000011'::uuid, v_challenge_id, 'active');
end
$$;

insert into overlay_sessions (id, channel_id, token_fingerprint, created_at, expires_at, revoked_at)
values ('00000000-0000-4000-8000-000000001705', '00000000-0000-4000-8000-000000000011', 'l17_overlay_fingerprint', current_timestamp, current_timestamp + interval '1 day', null)
on conflict (id) do nothing;

do $$
declare row_count integer; found_title text;
begin
  select count(*) into row_count from app_private.list_overlay_challenge('00000000-0000-4000-8000-000000001705'::uuid, 'l17_overlay_fingerprint');
  if row_count <> 1 then raise exception 'CHECK DOES NOT HOLD: overlay widget read did not find the live public challenge, got % rows', row_count; end if;
  select title into found_title from app_private.list_overlay_challenge('00000000-0000-4000-8000-000000001705'::uuid, 'l17_overlay_fingerprint');
  if found_title <> 'Overlay bounty' then raise exception 'unexpected overlay challenge title: %', found_title; end if;
end
$$;
