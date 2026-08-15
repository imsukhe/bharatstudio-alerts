-- BharatStudio Alerts v1 L04 verified webhook persistence.
--
-- Depends on 0001 through 0006. The payment service calls this function only
-- after raw-body signature and provider-event identity verification. Provider
-- network calls never happen inside this function.

alter table payments add column environment text;
alter table payments add column connected_account_ref text;
alter table payment_webhook_deliveries add column provider_event_name text not null default 'unknown';

create index payments_order_account_idx
  on payments (provider, environment, connected_account_ref, provider_order_id);

create or replace function app_private.record_verified_payment_webhook(
  target_delivery_id uuid,
  target_environment text,
  target_connected_account_ref text,
  target_provider_event_id text,
  target_raw_body_hash text,
  target_signature_verified_at timestamptz,
  target_received_at timestamptz,
  target_normalized jsonb,
  target_payment_id uuid,
  target_refund_id uuid,
  target_alert_event_id uuid,
  target_outbox_id uuid,
  target_delivery_rows jsonb
)
returns table (
  duplicate boolean,
  quarantined boolean,
  payment_id uuid,
  alert_event_id uuid,
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
  normalized_payment_id text := target_normalized ->> 'paymentId';
  normalized_order_id text := target_normalized ->> 'orderId';
  normalized_currency text := target_normalized ->> 'currency';
  normalized_status text := target_normalized ->> 'status';
  normalized_amount bigint := nullif(target_normalized ->> 'amountPaise', '')::bigint;
  normalized_refund_amount bigint := nullif(target_normalized ->> 'refundAmount', '')::bigint;
  local_payment_id uuid;
  local_channel_id uuid;
  local_intent payment_order_intents%rowtype;
  existing_delivery_id uuid;
  local_alert_event_id uuid;
  local_outbox_id uuid;
  delivery_count integer := 0;
  delivery jsonb;
  payment_status text;
  refund_status text;
begin
  if target_environment not in ('test', 'live')
     or target_connected_account_ref is null
     or target_provider_event_id is null
     or length(target_provider_event_id) = 0
     or target_normalized is null
     or normalized_event is null
     or normalized_type not in ('payment', 'refund', 'subscription', 'dispute')
     or normalized_entity_id is null
     or target_delivery_id is null
     or target_signature_verified_at is null
     or target_received_at is null then
    raise exception 'invalid normalized payment webhook' using errcode = '22023';
  end if;

  insert into public.payment_webhook_deliveries (
    id, provider, environment, connected_account_ref, provider_event_id,
    provider_event_name, entity_type, entity_id, raw_body_hash,
    signature_verified_at, received_at, processing_status
  )
  values (
    target_delivery_id, 'razorpay', target_environment, target_connected_account_ref,
    target_provider_event_id, normalized_event, normalized_type, normalized_entity_id,
    target_raw_body_hash, target_signature_verified_at, target_received_at, 'received'
  )
  on conflict (provider, environment, connected_account_ref, provider_event_id)
  do nothing
  returning id into existing_delivery_id;

  if existing_delivery_id is null then
    return query select true, false, null::uuid, null::uuid, 'duplicate';
    return;
  end if;

  if normalized_type = 'payment' then
    if normalized_payment_id is null or normalized_order_id is null or normalized_amount is null or normalized_amount < 1000 or normalized_currency <> 'INR' then
      update public.payment_webhook_deliveries
         set processing_status = 'quarantined'
       where id = target_delivery_id;
      return query select false, true, null::uuid, null::uuid, 'quarantined';
      return;
    end if;

    select intent.*
      into local_intent
      from public.payment_order_intents intent
     where intent.provider = 'razorpay'
       and intent.environment = target_environment
       and intent.connected_account_ref = target_connected_account_ref
       and intent.provider_order_id = normalized_order_id
     limit 1;

    if not found
       or local_intent.gross_amount_paise <> normalized_amount
       or local_intent.currency <> normalized_currency then
      update public.payment_webhook_deliveries
         set processing_status = 'quarantined'
       where id = target_delivery_id;
      return query select false, true, null::uuid, null::uuid, 'quarantined';
      return;
    end if;

    local_channel_id := local_intent.channel_id;
    select payment.id
      into local_payment_id
      from public.payments payment
     where payment.provider = 'razorpay'
       and payment.provider_payment_id = normalized_payment_id
     limit 1;

    payment_status := case
      when normalized_event in ('payment.captured', 'order.paid') then 'captured'
      when normalized_event = 'payment.failed' then 'failed'
      when normalized_event = 'payment.authorized' then 'pending'
      else 'pending'
    end;

    if local_payment_id is null then
      local_payment_id := target_payment_id;
      if local_payment_id is null then
        raise exception 'payment local id required' using errcode = '22023';
      end if;
      insert into public.payments (
        id, channel_id, provider, provider_payment_id, provider_order_id,
        gross_amount_paise, currency, status, environment, connected_account_ref,
        created_at, updated_at
      )
      values (
        local_payment_id, local_channel_id, 'razorpay', normalized_payment_id,
        normalized_order_id, normalized_amount, normalized_currency, payment_status,
        target_environment, target_connected_account_ref, current_timestamp, current_timestamp
      );
    else
      update public.payments payment
         set status = case
                       when payment.status in ('refunded', 'partially_refunded') then payment.status
                       when payment_status = 'captured' then 'captured'
                       when payment.status = 'captured' then payment.status
                       else payment_status
                     end,
             updated_at = current_timestamp
       where payment.id = local_payment_id;
    end if;

    if payment_status = 'captured' then
      update public.payment_order_intents
         set status = 'paid', updated_at = current_timestamp
       where id = local_intent.id;

      if local_intent.alert_consent then
        -- Razorpay documents `order.paid` and `payment.captured` as two
        -- event types for the same captured payment. The delivery IDs are
        -- intentionally recorded separately, but the business payment must
        -- create only one alert/outbox effect. A prior captured projection is
        -- complete because this function writes it atomically.
        select event.id
          into local_alert_event_id
          from public.alert_events event
         where event.payment_id = local_payment_id
         order by event.created_at asc, event.id asc
         limit 1;

        if local_alert_event_id is null then
          if target_alert_event_id is null or target_outbox_id is null then
            update public.payment_webhook_deliveries
               set processing_status = 'quarantined'
             where id = target_delivery_id;
            return query select false, true, local_payment_id, null::uuid, 'quarantined';
            return;
          end if;

          local_alert_event_id := target_alert_event_id;
          local_outbox_id := target_outbox_id;
          insert into public.alert_events (
            id, channel_id, payment_id, source_type, source_id, trace_id,
            config_snapshot_version, payload, created_at
          )
          values (
            local_alert_event_id, local_channel_id, local_payment_id, 'payment',
            normalized_payment_id, 'razorpay:' || target_provider_event_id,
            coalesce(nullif(target_delivery_rows -> 0 ->> 'configSnapshotVersion', '')::bigint, 1),
            target_normalized || jsonb_build_object(
              'displayName', local_intent.donor_display_name,
              'message', local_intent.donor_message
            ), current_timestamp
          );

          insert into public.event_outbox (id, event_id, status, available_at, created_at, updated_at)
          values (local_outbox_id, local_alert_event_id, 'pending', current_timestamp, current_timestamp, current_timestamp);

          for delivery in select value from jsonb_array_elements(coalesce(target_delivery_rows, '[]'::jsonb)) loop
            if not (delivery ? 'sourcePriority') or not (delivery ? 'overrideValues') then
              raise exception 'payment delivery routing snapshot missing' using errcode = '22023';
            end if;
            if not exists (
              select 1
                from public.queue_bindings binding
               where binding.id = (delivery ->> 'bindingId')::uuid
                 and binding.channel_id = local_channel_id
                 and binding.closed_at is null
                 and binding.source_type = 'payment'
                 and binding.source_id in (normalized_payment_id, '__channel_default__')
                 and not (
                   binding.source_id = '__channel_default__'
                   and exists (
                     select 1
                       from public.queue_bindings exact_binding
                      where exact_binding.channel_id = local_channel_id
                        and exact_binding.closed_at is null
                        and exact_binding.source_type = 'payment'
                        and exact_binding.source_id = normalized_payment_id
                   )
                 )
                 and binding.queue_id = (delivery ->> 'queueId')::uuid
                 and binding.priority = (delivery ->> 'sourcePriority')::integer
                 and coalesce(binding.override_values, 'null'::jsonb) = coalesce(delivery -> 'overrideValues', 'null'::jsonb)
            ) then
              raise exception 'payment delivery binding mismatch' using errcode = '42501';
            end if;

            insert into public.event_outbox_deliveries (
              id, event_id, outbox_id, queue_id, binding_id, source_id,
              config_snapshot_version, delivery_sequence, source_priority, override_values,
              status, attempt_count,
              created_at, updated_at
            )
            values (
              (delivery ->> 'deliveryId')::uuid, local_alert_event_id, local_outbox_id,
              (delivery ->> 'queueId')::uuid, (delivery ->> 'bindingId')::uuid,
              normalized_payment_id,
              (delivery ->> 'configSnapshotVersion')::bigint,
              (delivery ->> 'deliverySequence')::bigint,
              (delivery ->> 'sourcePriority')::integer,
              delivery -> 'overrideValues',
              'ready', 0, current_timestamp, current_timestamp
            );
            delivery_count := delivery_count + 1;
          end loop;

          if delivery_count = 0 then
            update public.event_outbox
               set status = 'quarantined', updated_at = current_timestamp
             where id = local_outbox_id;
            update public.payment_webhook_deliveries
               set processing_status = 'quarantined'
             where id = target_delivery_id;
            return query select false, true, local_payment_id, local_alert_event_id, 'quarantined';
            return;
          end if;
        end if;
      end if;
    end if;

    update public.payment_webhook_deliveries
       set processing_status = 'processed'
     where id = target_delivery_id;
    return query select false, false, local_payment_id, local_alert_event_id, 'processed';
    return;
  end if;

  if normalized_type = 'refund' then
    if normalized_payment_id is null or normalized_refund_amount is null or normalized_refund_amount <= 0 then
      update public.payment_webhook_deliveries
         set processing_status = 'quarantined'
       where id = target_delivery_id;
      return query select false, true, null::uuid, null::uuid, 'quarantined';
      return;
    end if;

    select payment.id, payment.channel_id
      into local_payment_id, local_channel_id
      from public.payments payment
     where payment.provider = 'razorpay'
       and payment.provider_payment_id = normalized_payment_id
       and payment.environment = target_environment
       and payment.connected_account_ref = target_connected_account_ref
     limit 1;

    if not found or target_refund_id is null then
      update public.payment_webhook_deliveries
         set processing_status = 'quarantined'
       where id = target_delivery_id;
      return query select false, true, local_payment_id, null::uuid, 'quarantined';
      return;
    end if;

    refund_status := case
      when normalized_event = 'refund.processed' then 'processed'
      when normalized_event = 'refund.failed' then 'failed'
      else 'requested'
    end;
    insert into public.refunds (
      id, payment_id, provider_refund_id, amount_paise, status, created_at, updated_at
    )
    values (
      target_refund_id, local_payment_id, normalized_entity_id,
      normalized_refund_amount, refund_status, current_timestamp, current_timestamp
    )
    on conflict (provider_refund_id) do nothing;

    if refund_status = 'processed' then
      update public.payments payment
         set status = case
                       when coalesce((select sum(refund.amount_paise) from public.refunds refund where refund.payment_id = payment.id and refund.status = 'processed'), 0) >= payment.gross_amount_paise then 'refunded'
                       else 'partially_refunded'
                     end,
             updated_at = current_timestamp
       where payment.id = local_payment_id;
    end if;

    update public.payment_webhook_deliveries
       set processing_status = 'processed'
     where id = target_delivery_id;
    return query select false, false, local_payment_id, null::uuid, 'processed';
    return;
  end if;

  update public.payment_webhook_deliveries
     set processing_status = 'quarantined'
   where id = target_delivery_id;
  return query select false, true, null::uuid, null::uuid, 'quarantined';
end
$$;

revoke execute on function app_private.record_verified_payment_webhook(uuid, text, text, text, text, timestamptz, timestamptz, jsonb, uuid, uuid, uuid, uuid, jsonb) from public;
grant execute on function app_private.record_verified_payment_webhook(uuid, text, text, text, text, timestamptz, timestamptz, jsonb, uuid, uuid, uuid, uuid, jsonb) to bsa_payment;
grant select on public.payment_order_intents, public.queue_bindings, public.channel_configs to bsa_payment;
grant usage on schema app_private to bsa_payment;
