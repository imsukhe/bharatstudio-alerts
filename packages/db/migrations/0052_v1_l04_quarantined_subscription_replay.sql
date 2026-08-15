-- L04 early-subscription-webhook repair.
--
-- A provider may deliver a subscription event before the server has completed
-- the local subscription link. The first delivery is retained as quarantine
-- evidence, but an exact same signed delivery must be replayable after the
-- link is repaired. Non-quarantined duplicates remain idempotent duplicates.

create or replace function app_private.record_verified_subscription_webhook(
  target_delivery_id uuid,
  target_environment text,
  target_connected_account_ref text,
  target_provider_event_id text,
  target_raw_body_hash text,
  target_signature_verified_at timestamptz,
  target_received_at timestamptz,
  target_normalized jsonb
)
returns table (
  duplicate boolean,
  quarantined boolean,
  subscription_id uuid,
  channel_id uuid,
  delivery_status text
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  normalized_event text := target_normalized ->> 'event';
  normalized_type text := target_normalized ->> 'entityType';
  normalized_entity_id text := target_normalized ->> 'entityId';
  normalized_status text := target_normalized ->> 'status';
  normalized_start bigint := nullif(target_normalized ->> 'currentStart', '')::bigint;
  normalized_end bigint := nullif(target_normalized ->> 'currentEnd', '')::bigint;
  normalized_charge bigint := nullif(target_normalized ->> 'chargeAt', '')::bigint;
  local_link public.channel_subscription_links%rowtype;
  local_subscription public.channel_subscriptions%rowtype;
  target_status text;
  period_start timestamptz;
  period_end timestamptz;
  renewal_at timestamptz;
  apply_result text;
  delivery_row_id uuid;
  existing_delivery_status text;
  existing_delivery_hash text;
  has_local_subscription boolean;
begin
  if target_environment not in ('test', 'live')
     or target_connected_account_ref = ''
     or target_provider_event_id = ''
     or target_normalized is null
     or normalized_type <> 'subscription'
     or normalized_entity_id = ''
     or target_delivery_id is null
     or target_signature_verified_at is null
     or target_received_at is null then
    raise exception 'invalid normalized subscription webhook' using errcode = '22023';
  end if;

  select delivery.id, delivery.processing_status, delivery.raw_body_hash
    into delivery_row_id, existing_delivery_status, existing_delivery_hash
    from public.payment_webhook_deliveries delivery
   where delivery.provider = 'razorpay'
     and delivery.environment = target_environment
     and delivery.connected_account_ref = target_connected_account_ref
     and delivery.provider_event_id = target_provider_event_id
   for update;

  if found then
    if existing_delivery_status <> 'quarantined'
       or existing_delivery_hash is distinct from target_raw_body_hash then
      return query select true, false, null::uuid, null::uuid, 'duplicate';
      return;
    end if;
    update public.payment_webhook_deliveries
       set processing_status = 'received'
     where id = delivery_row_id;
  else
    insert into public.payment_webhook_deliveries (
      id, provider, environment, connected_account_ref, provider_event_id,
      provider_event_name, entity_type, entity_id, raw_body_hash,
      signature_verified_at, received_at, processing_status
    ) values (
      target_delivery_id, 'razorpay', target_environment, target_connected_account_ref,
      target_provider_event_id, normalized_event, 'subscription', normalized_entity_id,
      target_raw_body_hash, target_signature_verified_at, target_received_at, 'received'
    )
    returning id into delivery_row_id;
  end if;

  select link.* into local_link
    from public.channel_subscription_links link
   where link.provider = 'razorpay'
     and link.environment = target_environment
     and link.provider_account_ref = target_connected_account_ref
     and link.provider_subscription_id = normalized_entity_id
   for update;

  if not found then
    update public.payment_webhook_deliveries
       set processing_status = 'quarantined'
     where id = delivery_row_id;
    return query select false, true, null::uuid, null::uuid, 'quarantined';
    return;
  end if;

  if coalesce(target_normalized ->> 'planId', '') <> local_link.provider_plan_id then
    update public.payment_webhook_deliveries
       set processing_status = 'quarantined'
     where id = delivery_row_id;
    return query select false, true, null::uuid, local_link.channel_id, 'quarantined';
    return;
  end if;

  if normalized_event = 'subscription.authenticated'
     or normalized_status in ('authenticated', 'created') then
    update public.payment_webhook_deliveries
       set processing_status = 'quarantined'
     where id = delivery_row_id;
    return query select false, true, null::uuid, local_link.channel_id, 'quarantined';
    return;
  end if;

  target_status := case
    when normalized_status in ('cancelled', 'completed')
      or normalized_event in ('subscription.cancelled', 'subscription.completed') then 'cancelled'
    when normalized_status in ('pending', 'halted')
      or normalized_event in ('subscription.pending', 'subscription.halted') then 'past_due'
    when normalized_status in ('active', 'authenticated')
      or normalized_event in ('subscription.activated', 'subscription.charged', 'subscription.updated') then 'active'
    else null
  end;

  if target_status is null then
    update public.payment_webhook_deliveries
       set processing_status = 'quarantined'
     where id = delivery_row_id;
    return query select false, true, null::uuid, local_link.channel_id, 'quarantined';
    return;
  end if;

  select subscription.* into local_subscription
    from public.channel_subscriptions subscription
   where subscription.provider = 'razorpay'
     and subscription.environment = target_environment
     and subscription.provider_account_ref = target_connected_account_ref
     and subscription.provider_subscription_id = normalized_entity_id
   for update;
  has_local_subscription := found;

  period_start := case when normalized_start is null then null else to_timestamp(normalized_start) end;
  period_end := case when normalized_end is null then null else to_timestamp(normalized_end) end;
  if period_start is null and has_local_subscription then period_start := local_subscription.current_period_start; end if;
  if period_end is null and has_local_subscription then period_end := local_subscription.current_period_end; end if;
  if period_start is null or period_end is null or period_end <= period_start then
    update public.payment_webhook_deliveries
       set processing_status = 'quarantined'
     where id = delivery_row_id;
    return query select false, true, null::uuid, local_link.channel_id, 'quarantined';
    return;
  end if;
  renewal_at := case when normalized_charge is null then null else to_timestamp(normalized_charge) end;

  select result into apply_result
    from app_private.apply_channel_subscription_state(
      local_link.channel_id, target_environment, target_connected_account_ref,
      normalized_entity_id, local_link.tier, local_link.billing_interval,
      local_link.recurring_price_paise, target_status,
      target_status <> 'cancelled', period_start, period_end, renewal_at,
      target_received_at
    );

  update public.payment_webhook_deliveries
     set processing_status = 'processed'
   where id = delivery_row_id;
  return query select false, false,
    case when apply_result = 'stale' then local_subscription.id else md5('subscription:' || target_environment || ':' || normalized_entity_id)::uuid end,
    local_link.channel_id, 'processed';
end
$$;

revoke execute on function app_private.record_verified_subscription_webhook(uuid, text, text, text, text, timestamptz, timestamptz, jsonb) from public;
grant execute on function app_private.record_verified_subscription_webhook(uuid, text, text, text, text, timestamptz, timestamptz, jsonb) to bsa_payment;
