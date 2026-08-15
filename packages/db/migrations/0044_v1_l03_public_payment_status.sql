-- BharatStudio Alerts v1 donor-safe payment status projection.
--
-- The order UUID is the unguessable capability returned by order creation.
-- This projection deliberately returns no donor, channel, provider account,
-- provider order, message or internal routing fields.

create or replace function app_private.get_public_payment_status(target_intent_id uuid)
returns table (
  order_id uuid,
  status text,
  amount_paise bigint,
  currency text,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select intent.id,
         intent.status,
         intent.gross_amount_paise,
         intent.currency,
         intent.updated_at
    from public.payment_order_intents intent
   where intent.id = target_intent_id
$$;

revoke execute on function app_private.get_public_payment_status(uuid) from public;
grant execute on function app_private.get_public_payment_status(uuid) to bsa_app;
