-- L04/L14: opaque anonymous checkout identity is attached exactly once by the
-- trusted verified-webhook transaction. Synthetic data only.
\set ON_ERROR_STOP on

insert into alert_queues (id, channel_id, name, created_at, updated_at)
values ('00000000-0000-4000-8000-000000001720', '00000000-0000-4000-8000-000000000011', 'L04L14 queue', current_timestamp, current_timestamp);
insert into payment_accounts (id, channel_id, provider, environment, connected_account_ref, status, created_at, updated_at)
values ('00000000-0000-4000-8000-000000001721', '00000000-0000-4000-8000-000000000011', 'razorpay', 'test', 'acct_l04l14', 'active', current_timestamp, current_timestamp);
insert into queue_bindings (id, channel_id, queue_id, source_type, source_id, allow_duplicates, priority, override_values, created_at)
values ('00000000-0000-4000-8000-000000001722', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000001720', 'payment', 'pay_l04l14', true, 10, '{}'::jsonb, current_timestamp);

begin;
set local role bsa_payment;
select * from app_private.create_payment_order_intent_with_identity(
  '00000000-0000-4000-8000-000000001723', '00000000-0000-4000-8000-000000000011', 'test',
  'l04l14-idempotency-key-0001', 'l04l14-receipt', 5000, 'Synthetic', 'Identity proof', true,
  current_timestamp + interval '10 minutes', repeat('a', 64)
) \gset l04l14_
select * from app_private.claim_payment_order_intent(:'l04l14_intent_id'::uuid, '00000000-0000-4000-8000-000000001724', current_timestamp + interval '1 minute');
select * from app_private.attach_provider_order(:'l04l14_intent_id'::uuid, '00000000-0000-4000-8000-000000001724', 'order_l04l14', current_timestamp);
select * from app_private.record_verified_payment_webhook_with_identity(
  '00000000-0000-4000-8000-000000001725', 'test', 'acct_l04l14', 'event_l04l14', 'hash_l04l14',
  current_timestamp, current_timestamp,
  '{"event":"payment.captured","entityType":"payment","entityId":"pay_l04l14","paymentId":"pay_l04l14","orderId":"order_l04l14","amountPaise":"5000","currency":"INR","status":"captured"}'::jsonb,
  '00000000-0000-4000-8000-000000001726', null, '00000000-0000-4000-8000-000000001727',
  '00000000-0000-4000-8000-000000001728',
  '[{"deliveryId":"00000000-0000-4000-8000-000000001729","queueId":"00000000-0000-4000-8000-000000001720","bindingId":"00000000-0000-4000-8000-000000001722","configSnapshotVersion":"1","deliverySequence":"1","sourcePriority":"10","overrideValues":{}}]'::jsonb
);
select * from app_private.record_verified_payment_webhook_with_identity(
  '00000000-0000-4000-8000-000000001730', 'test', 'acct_l04l14', 'event_l04l14', 'hash_l04l14',
  current_timestamp, current_timestamp,
  '{"event":"payment.captured","entityType":"payment","entityId":"pay_l04l14","paymentId":"pay_l04l14","orderId":"order_l04l14","amountPaise":"5000","currency":"INR","status":"captured"}'::jsonb,
  '00000000-0000-4000-8000-000000001731', null, '00000000-0000-4000-8000-000000001732',
  '00000000-0000-4000-8000-000000001733', '[]'::jsonb
);
commit;

do $$
declare identity_id uuid;
  alert_identity_id uuid;
  relation_count integer;
  anonymous_count integer;
begin
  select viewer_identity_id into identity_id from payments where id = '00000000-0000-4000-8000-000000001726';
  select viewer_identity_id into alert_identity_id from alert_events where id = '00000000-0000-4000-8000-000000001727';
  select count(*) into relation_count from creator_supporter_relations where channel_id = '00000000-0000-4000-8000-000000000011' and viewer_identity_id = identity_id and lifetime_amount_paise = 5000 and tip_count = 1;
  select count(*) into anonymous_count from anonymous_browser_identities where token_hash = repeat('a', 64);
  if identity_id is null or alert_identity_id is distinct from identity_id or relation_count <> 1 or anonymous_count <> 1 then
    raise exception 'anonymous payment identity attribution failed payment=% alert=% relations=% anonymous=%', identity_id, alert_identity_id, relation_count, anonymous_count;
  end if;
end $$;

-- Expiry must create a new anonymous identity.  The historic identity remains
-- for payment/audit linkage, but its lookup fingerprint is retired so a stale
-- raw cookie cannot recover it.
select app_private.resolve_anonymous_payment_identity(repeat('b', 64)) as first_identity \gset l04l14_expired_
update anonymous_browser_identities
   set expires_at = current_timestamp - interval '1 second'
 where token_hash = repeat('b', 64);
select app_private.resolve_anonymous_payment_identity(repeat('b', 64)) as second_identity \gset l04l14_expired_
select set_config('app.l04l14_first_expired_identity', :'l04l14_expired_first_identity', false);
select set_config('app.l04l14_second_expired_identity', :'l04l14_expired_second_identity', false);
do $$
declare first_identity uuid := current_setting('app.l04l14_first_expired_identity')::uuid;
  second_identity uuid := current_setting('app.l04l14_second_expired_identity')::uuid;
  active_count integer;
begin
  select count(*) into active_count
    from anonymous_browser_identities
   where token_hash = repeat('b', 64)
     and expires_at > current_timestamp;
  if first_identity = second_identity or active_count <> 1 then
    raise exception 'expired anonymous identity was reused or not replaced: first=% second=% active=%', first_identity, second_identity, active_count;
  end if;
end $$;

-- Webhook ordering is not guaranteed.  An authorization may arrive first,
-- then capture, then a full refund.  Identity must reach the later-created
-- alert; the supporter aggregate must be net/refund-safe rather than an
-- arrival-order-dependent increment.
insert into queue_bindings (id, channel_id, queue_id, source_type, source_id, allow_duplicates, priority, override_values, created_at)
values ('00000000-0000-4000-8000-000000001734', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000001720', 'payment', 'pay_l04l14_authorized', true, 10, '{}'::jsonb, current_timestamp);

begin;
set local role bsa_payment;
select * from app_private.create_payment_order_intent_with_identity(
  '00000000-0000-4000-8000-000000001735', '00000000-0000-4000-8000-000000000011', 'test',
  'l04l14-idempotency-key-0002', 'l04l14-receipt-2', 7000, 'Synthetic', 'Ordered proof', true,
  current_timestamp + interval '10 minutes', repeat('a', 64)
) \gset l04l14_ordered_
select * from app_private.claim_payment_order_intent(:'l04l14_ordered_intent_id'::uuid, '00000000-0000-4000-8000-000000001736', current_timestamp + interval '1 minute');
select * from app_private.attach_provider_order(:'l04l14_ordered_intent_id'::uuid, '00000000-0000-4000-8000-000000001736', 'order_l04l14_authorized', current_timestamp);
select * from app_private.record_verified_payment_webhook_with_identity(
  '00000000-0000-4000-8000-000000001737', 'test', 'acct_l04l14', 'event_l04l14_authorized', 'hash_l04l14_authorized',
  current_timestamp, current_timestamp,
  '{"event":"payment.authorized","entityType":"payment","entityId":"pay_l04l14_authorized","paymentId":"pay_l04l14_authorized","orderId":"order_l04l14_authorized","amountPaise":"7000","currency":"INR","status":"authorized"}'::jsonb,
  '00000000-0000-4000-8000-000000001738', null, null, null, '[]'::jsonb
);
select * from app_private.record_verified_payment_webhook_with_identity(
  '00000000-0000-4000-8000-000000001741', 'test', 'acct_l04l14', 'event_l04l14_captured', 'hash_l04l14_captured',
  current_timestamp, current_timestamp,
  '{"event":"payment.captured","entityType":"payment","entityId":"pay_l04l14_authorized","paymentId":"pay_l04l14_authorized","orderId":"order_l04l14_authorized","amountPaise":"7000","currency":"INR","status":"captured"}'::jsonb,
  '00000000-0000-4000-8000-000000001742', null, '00000000-0000-4000-8000-000000001743',
  '00000000-0000-4000-8000-000000001744',
  '[{"deliveryId":"00000000-0000-4000-8000-000000001745","queueId":"00000000-0000-4000-8000-000000001720","bindingId":"00000000-0000-4000-8000-000000001734","configSnapshotVersion":"1","deliverySequence":"1","sourcePriority":"10","overrideValues":{}}]'::jsonb
);
select * from app_private.record_verified_payment_webhook_with_identity(
  '00000000-0000-4000-8000-000000001746', 'test', 'acct_l04l14', 'event_l04l14_refund', 'hash_l04l14_refund',
  current_timestamp, current_timestamp,
  '{"event":"refund.processed","entityType":"refund","entityId":"refund_l04l14_authorized","paymentId":"pay_l04l14_authorized","amountPaise":"7000","refundAmount":"7000","currency":"INR","status":"processed"}'::jsonb,
  null, '00000000-0000-4000-8000-000000001747', null, null, '[]'::jsonb
);
commit;

do $$
declare identity_id uuid;
  alert_identity_id uuid;
  relation_count integer;
begin
  select viewer_identity_id into identity_id from payments where id = '00000000-0000-4000-8000-000000001738';
  select viewer_identity_id into alert_identity_id from alert_events where id = '00000000-0000-4000-8000-000000001743';
  select count(*) into relation_count from creator_supporter_relations
   where channel_id = '00000000-0000-4000-8000-000000000011'
     and viewer_identity_id = identity_id
     and lifetime_amount_paise = 5000
     and tip_count = 1;
  if identity_id is null or alert_identity_id is distinct from identity_id or relation_count <> 1 then
    raise exception 'ordered/refunded identity attribution failed payment=% alert=% relations=%', identity_id, alert_identity_id, relation_count;
  end if;
end $$;

select 'L04_L14_ANONYMOUS_PAYMENT_IDENTITY=PASS' as result;
