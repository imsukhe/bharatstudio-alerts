-- AUD-PAY-02: a TipIntent is a single payment-authorisation link, not an
-- acknowledgement that a provider order was created.  0097 consumed the
-- link before the payment-order service had confirmed a durable local intent.
-- A transient provider/service failure could therefore burn the link without
-- creating an order.  This migration introduces a durable checkout
-- reservation: reserve one stable local intent + idempotency key first, and
-- mark the link consumed only after the service returns that same local order.
--
-- The reservation is deliberately kept on tip_intents rather than a second
-- table.  A link has at most one checkout and no independent lifecycle: an
-- absent order_id is unreserved, a present order_id plus key is reserved, and
-- consumed_at means the verified checkout was created.  This keeps the
-- single-use boundary in one locked row and gives no role raw table access.
-- Existing consumed rows from 0097 have order_id but no reservation key;
-- they remain readable as 'used' and are never re-opened or rewritten.

alter table public.tip_intents
  add column if not exists checkout_idempotency_key text;

alter table public.tip_intents
  add constraint tip_intents_checkout_idempotency_key_format
  check (checkout_idempotency_key is null or checkout_idempotency_key ~ '^[A-Za-z0-9._:-]{16,128}$');

comment on column public.tip_intents.checkout_idempotency_key is
  'AUD-PAY-02 stable payment-order idempotency key reserved for an unconsumed TipIntent. Never returned by public reads; same key retries the durable local intent after transient checkout failure.';

-- Reserve a checkout while holding the one TipIntent row lock.  No sensitive
-- amount/name/message leaves this function for a different-key conflict or
-- used link: callers get only a state marker. Repeating the original key
-- returns the original stable intent so the Go payment service can safely
-- recover its own persisted intent / provider-creation lease, including when
-- an HTTP response was lost after local order creation completed.
create or replace function app_private.reserve_tip_intent_checkout(
  target_token_hash text,
  target_idempotency_key text,
  target_order_id uuid
)
returns table (
  state text,
  order_id uuid,
  checkout_idempotency_key text,
  channel_id uuid,
  amount_paise integer,
  currency text,
  donor_display_name text,
  message text
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  existing public.tip_intents%rowtype;
begin
  if target_token_hash is null
     or target_order_id is null
     or target_idempotency_key is null
     or target_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$' then
    raise exception 'invalid tip intent checkout reservation' using errcode = '22023';
  end if;

  select intent.* into existing
    from public.tip_intents intent
   where intent.token_hash = target_token_hash
   for update;
  if not found then
    return;
  end if;

  if existing.consumed_at is not null then
    if existing.order_id is not null
       and existing.checkout_idempotency_key = target_idempotency_key then
      -- Idempotent recovery after the client lost a successful 201. The
      -- stored key is not a public credential: it is only held in the page
      -- instance which initiated the checkout and never returned by GET.
      return query select 'completed'::text, existing.order_id,
                          existing.checkout_idempotency_key, existing.channel_id,
                          existing.amount_paise, existing.currency,
                          existing.donor_display_name, existing.message;
    end if;
    return query select 'used'::text, null::uuid, null::text,
                        null::uuid, null::integer, null::text, null::text, null::text;
    return;
  end if;

  if existing.expires_at <= current_timestamp then
    return;
  end if;

  if existing.order_id is null then
    update public.tip_intents intent
       set order_id = target_order_id,
           checkout_idempotency_key = target_idempotency_key
     where intent.id = existing.id;
    existing.order_id := target_order_id;
    existing.checkout_idempotency_key := target_idempotency_key;
  elsif existing.checkout_idempotency_key is distinct from target_idempotency_key then
    -- A reservation may only drive its original payment-service intent.
    -- Do not disclose that intent's values to a request with another key.
    return query select 'in_progress'::text, null::uuid, null::text,
                        null::uuid, null::integer, null::text, null::text, null::text;
    return;
  end if;

  -- Legacy rows with order_id but no key are impossible for this runtime and
  -- fail closed rather than allowing an unbound second checkout.
  if existing.checkout_idempotency_key is null then
    return query select 'in_progress'::text, null::uuid, null::text,
                        null::uuid, null::integer, null::text, null::text, null::text;
    return;
  end if;

  return query select 'reserved'::text, existing.order_id,
                      existing.checkout_idempotency_key, existing.channel_id,
                      existing.amount_paise, existing.currency,
                      existing.donor_display_name, existing.message;
end
$$;

-- Finalisation is intentionally separate from reservation. It accepts only
-- the exact locked binding and has no expiry predicate: a checkout that was
-- validly reserved immediately before the short-link TTL elapsed must still
-- become 'used' after its durable local order is confirmed, never revert to
-- a misleading ready/expired link while that order exists.
create or replace function app_private.complete_tip_intent_checkout(
  target_token_hash text,
  target_order_id uuid,
  target_idempotency_key text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  updated_count integer;
begin
  if target_token_hash is null
     or target_order_id is null
     or target_idempotency_key is null
     or target_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$' then
    raise exception 'invalid tip intent checkout completion' using errcode = '22023';
  end if;

  update public.tip_intents intent
     set consumed_at = current_timestamp
   where intent.token_hash = target_token_hash
     and intent.order_id = target_order_id
     and intent.checkout_idempotency_key = target_idempotency_key
     and intent.consumed_at is null;
  get diagnostics updated_count = row_count;
  return updated_count = 1;
end
$$;

-- Keep the legacy function for its existing migration-era callers/tests, but
-- make it refuse a new reservation.  New runtime code has no TypeScript
-- binding for this function; reserve/complete above are the only checkout
-- path after 0164.
create or replace function app_private.consume_tip_intent(
  target_token_hash text,
  target_order_id uuid
)
returns table (
  id uuid,
  channel_id uuid,
  amount_paise integer,
  currency text,
  donor_display_name text,
  message text
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  existing public.tip_intents%rowtype;
begin
  if target_token_hash is null or target_order_id is null then
    raise exception 'invalid tip intent consume' using errcode = '22023';
  end if;

  select intent.* into existing
    from public.tip_intents intent
   where intent.token_hash = target_token_hash
     and intent.order_id is null
     and intent.consumed_at is null
     and intent.expires_at > current_timestamp
   for update;
  if not found then
    return;
  end if;

  update public.tip_intents intent
     set consumed_at = current_timestamp, order_id = target_order_id
   where intent.id = existing.id;

  return query select existing.id, existing.channel_id, existing.amount_paise,
                      existing.currency, existing.donor_display_name, existing.message;
end
$$;

revoke execute on function app_private.reserve_tip_intent_checkout(text, text, uuid) from public;
revoke execute on function app_private.complete_tip_intent_checkout(text, uuid, text) from public;
grant execute on function app_private.reserve_tip_intent_checkout(text, text, uuid) to bsa_app;
grant execute on function app_private.complete_tip_intent_checkout(text, uuid, text) to bsa_app;
