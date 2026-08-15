-- BharatStudio Alerts v1 refund webhook status synchronization.
--
-- 0007 keeps one refund row per provider refund ID. A later distinct webhook
-- for that same refund must still advance the existing row (for example
-- refund.created -> refund.processed); otherwise the event ledger is correct
-- while the financial state remains stale.

create or replace function app_private.sync_refund_webhook_status()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  affected_payment_id uuid;
begin
  if new.provider <> 'razorpay'
     or new.entity_type <> 'refund'
     or new.provider_event_name not in ('refund.processed', 'refund.failed', 'refund.reversed') then
    return new;
  end if;

  update public.refunds refund
     set status = case
       when new.provider_event_name = 'refund.reversed' then 'reversed'
       when new.provider_event_name = 'refund.processed'
         and refund.status <> 'reversed' then 'processed'
       when new.provider_event_name = 'refund.failed'
         and refund.status not in ('processed', 'reversed') then 'failed'
       else refund.status
     end,
         updated_at = current_timestamp
    from public.payments payment
   where refund.provider_refund_id = new.entity_id
     and refund.payment_id = payment.id
     and payment.provider = 'razorpay'
     and payment.environment = new.environment
     and payment.connected_account_ref = new.connected_account_ref
  returning refund.payment_id into affected_payment_id;

  if affected_payment_id is not null then
    update public.payments payment
       set status = case
         when payment.status not in ('captured', 'refunded', 'partially_refunded') then payment.status
         when coalesce((select sum(refund.amount_paise)
                          from public.refunds refund
                         where refund.payment_id = payment.id
                           and refund.status = 'processed'), 0) >= payment.gross_amount_paise then 'refunded'
         when exists (select 1 from public.refunds refund
                       where refund.payment_id = payment.id
                         and refund.status = 'processed') then 'partially_refunded'
         when payment.status in ('refunded', 'partially_refunded') then 'captured'
         else payment.status
       end,
           updated_at = current_timestamp
     where payment.id = affected_payment_id;
  end if;

  return new;
end
$$;

revoke execute on function app_private.sync_refund_webhook_status() from public;

drop trigger if exists payment_webhook_refund_status_sync on public.payment_webhook_deliveries;
create trigger payment_webhook_refund_status_sync
after insert on public.payment_webhook_deliveries
for each row execute function app_private.sync_refund_webhook_status();

create or replace function app_private.sync_new_refund_from_webhook()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  latest_event text;
begin
  select delivery.provider_event_name
    into latest_event
    from public.payment_webhook_deliveries delivery
    join public.payments payment on payment.id = new.payment_id
   where delivery.provider = 'razorpay'
     and delivery.entity_type = 'refund'
     and delivery.entity_id = new.provider_refund_id
     and delivery.environment = payment.environment
     and delivery.connected_account_ref = payment.connected_account_ref
   order by delivery.received_at desc, delivery.id desc
   limit 1;

  if latest_event is null
     or latest_event not in ('refund.processed', 'refund.failed', 'refund.reversed') then
    return new;
  end if;

  update public.refunds refund
     set status = case
       when latest_event = 'refund.processed' then 'processed'
       when latest_event = 'refund.failed' then 'failed'
       else 'reversed'
     end,
         updated_at = current_timestamp
   where refund.id = new.id;

  update public.payments payment
     set status = case
       when payment.status not in ('captured', 'refunded', 'partially_refunded') then payment.status
       when coalesce((select sum(refund.amount_paise)
                        from public.refunds refund
                       where refund.payment_id = payment.id
                         and refund.status = 'processed'), 0) >= payment.gross_amount_paise then 'refunded'
       when exists (select 1 from public.refunds refund
                     where refund.payment_id = payment.id
                       and refund.status = 'processed') then 'partially_refunded'
       when payment.status in ('refunded', 'partially_refunded') then 'captured'
       else payment.status
     end,
         updated_at = current_timestamp
   where payment.id = new.payment_id;

  return new;
end
$$;

revoke execute on function app_private.sync_new_refund_from_webhook() from public;

drop trigger if exists refund_webhook_initial_status_sync on public.refunds;
create trigger refund_webhook_initial_status_sync
after insert on public.refunds
for each row execute function app_private.sync_new_refund_from_webhook();
