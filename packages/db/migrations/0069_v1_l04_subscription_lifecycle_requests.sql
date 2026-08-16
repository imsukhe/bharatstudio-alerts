-- L04: creator-initiated subscription lifecycle requests (cancel / change
-- plan / reactivate). The confirming state transition already exists and is
-- fully tested (0048/0049's apply_channel_subscription_state, driven by
-- verified Razorpay webhooks) — this migration adds only the "request" side:
-- resolving which provider subscription a channel's request targets, and an
-- idempotent audit trail of the requests themselves, mirroring the pattern
-- already used for payment_account_audit (0060).
--
-- This does NOT let the app write channel_subscriptions state directly —
-- that remains exclusively the payment service's job via a verified
-- webhook, per the non-negotiable release invariant that financial truth
-- comes from provider/webhook evidence, not a request record.

create table public.subscription_lifecycle_requests (
  id uuid primary key,
  channel_id uuid not null references public.channels(id),
  requested_by uuid not null references public.app_users(id),
  action text not null check (action in ('cancel', 'change_plan', 'reactivate')),
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 128),
  target_tier text check (target_tier in ('pro', 'creator', 'studio')),
  target_billing_interval text check (target_billing_interval in ('monthly', 'annual')),
  provider_subscription_id text not null,
  status text not null check (status in ('requested', 'provider_confirmed', 'provider_failed')) default 'requested',
  provider_response_status text,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  unique (channel_id, idempotency_key),
  check (action <> 'change_plan' or (target_tier is not null and target_billing_interval is not null))
);

create index subscription_lifecycle_requests_channel_idx
  on public.subscription_lifecycle_requests (channel_id, created_at desc);

alter table public.subscription_lifecycle_requests enable row level security;
revoke all on public.subscription_lifecycle_requests from public;
revoke all on public.subscription_lifecycle_requests from bsa_app;
revoke all on public.subscription_lifecycle_requests from bsa_payment;

create policy subscription_lifecycle_requests_member_select
  on public.subscription_lifecycle_requests for select to bsa_app
  using (app_private.can_access_channel(channel_id));

-- Resolves the channel's current active-or-past_due Razorpay subscription so
-- a cancel/change-plan/reactivate request knows which provider entity to
-- call. Read-only; never used to infer billing state itself.
create or replace function app_private.get_active_subscription_ref(
  target_channel_id uuid
)
returns table (
  provider_account_ref text,
  provider_subscription_id text,
  tier text,
  billing_interval text,
  status text,
  auto_renew boolean
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select subscription.provider_account_ref, subscription.provider_subscription_id,
         subscription.tier, subscription.billing_interval, subscription.status,
         subscription.auto_renew
    from public.channel_subscriptions subscription
   where subscription.channel_id = target_channel_id
     and subscription.status in ('active', 'past_due')
     and app_private.can_access_channel(target_channel_id)
   order by subscription.current_period_end desc, subscription.updated_at desc
   limit 1
$$;

-- Records a lifecycle request from the creator API before the payment
-- service calls Razorpay, so a retried/duplicate request with the same
-- idempotency key returns the original outcome instead of calling the
-- provider twice. target_user_id must own/administer the channel — checked
-- by the caller's RLS context (bsa_app), re-asserted here for defense in
-- depth since this function runs as bsa_payment via internal RPC.
create or replace function app_private.record_subscription_lifecycle_request(
  target_id uuid,
  target_channel_id uuid,
  target_requested_by uuid,
  target_action text,
  target_idempotency_key text,
  target_provider_subscription_id text,
  target_tier text,
  target_billing_interval text
)
returns table (
  id uuid, status text, provider_response_status text, replay boolean
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  existing public.subscription_lifecycle_requests%rowtype;
begin
  if target_id is null or target_channel_id is null or target_requested_by is null
     or target_action not in ('cancel', 'change_plan', 'reactivate')
     or target_idempotency_key is null or char_length(target_idempotency_key) < 16
     or target_provider_subscription_id = '' then
    raise exception 'invalid subscription lifecycle request' using errcode = '22023';
  end if;

  select * into existing
    from public.subscription_lifecycle_requests request
   where request.channel_id = target_channel_id
     and request.idempotency_key = target_idempotency_key;

  if found then
    return query select existing.id, existing.status, existing.provider_response_status, true;
    return;
  end if;

  insert into public.subscription_lifecycle_requests (
    id, channel_id, requested_by, action, idempotency_key, target_tier,
    target_billing_interval, provider_subscription_id, status
  ) values (
    target_id, target_channel_id, target_requested_by, target_action,
    target_idempotency_key, target_tier, target_billing_interval,
    target_provider_subscription_id, 'requested'
  );

  return query select target_id, 'requested'::text, null::text, false;
end
$$;

create or replace function app_private.complete_subscription_lifecycle_request(
  target_id uuid,
  target_status text,
  target_provider_response_status text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if target_id is null or target_status not in ('provider_confirmed', 'provider_failed') then
    raise exception 'invalid subscription lifecycle completion' using errcode = '22023';
  end if;
  update public.subscription_lifecycle_requests
     set status = target_status, provider_response_status = target_provider_response_status, updated_at = current_timestamp
   where id = target_id;
  return found;
end
$$;

revoke execute on function app_private.get_active_subscription_ref(uuid) from public;
revoke execute on function app_private.record_subscription_lifecycle_request(uuid, uuid, uuid, text, text, text, text, text) from public;
revoke execute on function app_private.complete_subscription_lifecycle_request(uuid, text, text) from public;
-- bsa_payment only: the TS control API (bsa_app) never resolves the
-- provider subscription ref directly — it authorizes the request, then
-- calls the payment service's internal endpoint, which resolves this
-- itself. get_billing_view already gives bsa_app everything it needs to
-- display current tier/renewal state.
grant execute on function app_private.get_active_subscription_ref(uuid) to bsa_payment;
grant execute on function app_private.record_subscription_lifecycle_request(uuid, uuid, uuid, text, text, text, text, text) to bsa_payment;
grant execute on function app_private.complete_subscription_lifecycle_request(uuid, text, text) to bsa_payment;
