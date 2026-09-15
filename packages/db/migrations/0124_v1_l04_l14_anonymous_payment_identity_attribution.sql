-- L04/L14: attribute future public checkouts to opaque anonymous identities.
-- Raw browser tokens never enter this database; only a SHA-256 fingerprint
-- crosses the private checkout boundary. Existing procedures remain callable
-- for rollback compatibility and retain their nullable identity behavior.

alter table public.payment_order_intents
  add column if not exists viewer_identity_id uuid references public.viewer_identities(id);

create index if not exists payment_order_intents_viewer_identity_idx
  on public.payment_order_intents (viewer_identity_id) where viewer_identity_id is not null;

create or replace function app_private.resolve_anonymous_payment_identity(target_token_hash text)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  anonymous_id uuid;
  resolved_id uuid;
begin
  if target_token_hash is null or target_token_hash !~ '^[0-9a-f]{64}$' then
    return null;
  end if;

  select vi.id into resolved_id
    from public.anonymous_browser_identities abi
    join public.viewer_identities vi on vi.anonymous_identity_id = abi.id
   where abi.token_hash = target_token_hash
     and abi.expires_at > current_timestamp
   limit 1;
  if resolved_id is not null then return resolved_id; end if;

  -- token_hash is deliberately unique.  Retire an expired fingerprint before
  -- inserting the replacement identity: preserving the old browser/ledger
  -- rows retains audit linkage, while dropping the expired lookup key prevents
  -- a replayed stale token from recovering that prior identity. The raw token
  -- was never stored; this replacement is an unrelated opaque tombstone.
  update public.anonymous_browser_identities
     set token_hash = 'expired:' || id::text
   where token_hash = target_token_hash
     and expires_at <= current_timestamp;

  anonymous_id := gen_random_uuid();
  resolved_id := gen_random_uuid();
  begin
    insert into public.anonymous_browser_identities (id, token_hash, expires_at)
    values (anonymous_id, target_token_hash, current_timestamp + interval '30 days');
    insert into public.viewer_identities (id, kind, anonymous_identity_id)
    values (resolved_id, 'anonymous', anonymous_id);
    return resolved_id;
  exception when unique_violation then
    select vi.id into resolved_id
      from public.anonymous_browser_identities abi
      join public.viewer_identities vi on vi.anonymous_identity_id = abi.id
     where abi.token_hash = target_token_hash
       and abi.expires_at > current_timestamp
     limit 1;
    return resolved_id;
  end;
end
$$;

create or replace function app_private.create_payment_order_intent_with_identity(
  target_id uuid, target_channel_id uuid, target_environment text,
  target_idempotency_key text, target_provider_receipt text,
  target_amount_paise bigint, target_display_name text, target_message text,
  target_alert_consent boolean, target_expires_at timestamptz,
  target_anonymous_token_hash text
)
returns table (
  intent_id uuid, channel_id uuid, provider text, environment text,
  connected_account_ref text, provider_receipt text, provider_order_id text,
  amount_paise bigint, currency text, donor_display_name text,
  donor_message text, alert_consent boolean, status text, expires_at timestamptz
)
language plpgsql volatile security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  result record;
  identity_id uuid;
begin
  select * into result from app_private.create_payment_order_intent(
    target_id, target_channel_id, target_environment, target_idempotency_key,
    target_provider_receipt, target_amount_paise, target_display_name,
    target_message, target_alert_consent, target_expires_at
  );
  identity_id := app_private.resolve_anonymous_payment_identity(target_anonymous_token_hash);
  if identity_id is not null then
    update public.payment_order_intents
       set viewer_identity_id = coalesce(viewer_identity_id, identity_id)
     where id = result.intent_id;
  end if;
  return query select result.intent_id, result.channel_id, result.provider,
    result.environment, result.connected_account_ref, result.provider_receipt,
    result.provider_order_id, result.amount_paise, result.currency,
    result.donor_display_name, result.donor_message, result.alert_consent,
    result.status, result.expires_at;
end
$$;

-- A webhook can legitimately arrive as payment.authorized before
-- payment.captured.  Do not make the relation aggregate depend on the one
-- webhook which first sets the identity: project it from the payment ledger
-- whenever either the identity or the settlement state changes.  The
-- projection is a recomputation, not an increment, so duplicate webhooks,
-- state retries, partial refunds and full refunds cannot double-count support.
create or replace function app_private.sync_creator_supporter_relation_from_payment()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  supported_count bigint;
  net_amount bigint;
  first_supported timestamptz;
  last_supported timestamptz;
begin
  if new.viewer_identity_id is null
     or new.status not in ('captured', 'partially_refunded', 'refunded') then
    return new;
  end if;

  select count(*) filter (where payment.gross_amount_paise > coalesce(refunded.amount_paise, 0)),
         coalesce(sum(greatest(payment.gross_amount_paise - coalesce(refunded.amount_paise, 0), 0)), 0),
         min(payment.created_at),
         max(payment.created_at)
    into supported_count, net_amount, first_supported, last_supported
    from public.payments payment
    left join lateral (
      select sum(refund.amount_paise)::bigint as amount_paise
        from public.refunds refund
       where refund.payment_id = payment.id
         and refund.status = 'processed'
    ) refunded on true
   where payment.channel_id = new.channel_id
     and payment.viewer_identity_id = new.viewer_identity_id
     and payment.status in ('captured', 'partially_refunded', 'refunded');

  insert into public.creator_supporter_relations (
    channel_id, viewer_identity_id, first_supported_at, last_supported_at,
    lifetime_amount_paise, tip_count
  ) values (
    new.channel_id, new.viewer_identity_id, first_supported, last_supported,
    net_amount, supported_count
  ) on conflict (channel_id, viewer_identity_id) do update
    set first_supported_at = excluded.first_supported_at,
        last_supported_at = excluded.last_supported_at,
        lifetime_amount_paise = excluded.lifetime_amount_paise,
        tip_count = excluded.tip_count,
        updated_at = current_timestamp;
  return new;
end
$$;

drop trigger if exists sync_creator_supporter_relation_from_payment on public.payments;
create trigger sync_creator_supporter_relation_from_payment
after insert or update of viewer_identity_id, status on public.payments
for each row execute function app_private.sync_creator_supporter_relation_from_payment();

create or replace function app_private.record_verified_payment_webhook_with_identity(
  target_delivery_id uuid, target_environment text, target_connected_account_ref text,
  target_provider_event_id text, target_raw_body_hash text,
  target_signature_verified_at timestamptz, target_received_at timestamptz,
  target_normalized jsonb, target_payment_id uuid, target_refund_id uuid,
  target_alert_event_id uuid, target_outbox_id uuid, target_delivery_rows jsonb
)
returns table (duplicate boolean, quarantined boolean, payment_id uuid,
  alert_event_id uuid, delivery_status text)
language plpgsql volatile security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  result record;
  identity_id uuid;
begin
  select * into result from app_private.record_verified_payment_webhook(
    target_delivery_id, target_environment, target_connected_account_ref,
    target_provider_event_id, target_raw_body_hash, target_signature_verified_at,
    target_received_at, target_normalized, target_payment_id, target_refund_id,
    target_alert_event_id, target_outbox_id, target_delivery_rows
  );
  if result.payment_id is not null and target_normalized ->> 'entityType' = 'payment' then
    select intent.viewer_identity_id into identity_id
      from public.payment_order_intents intent
     where intent.provider = 'razorpay' and intent.environment = target_environment
       and intent.connected_account_ref = target_connected_account_ref
       and intent.provider_order_id = target_normalized ->> 'orderId'
     limit 1;
    if identity_id is not null then
      update public.payments p set viewer_identity_id = identity_id
       where p.id = result.payment_id and p.viewer_identity_id is null
       ;
      -- An authorized event may set the payment identity before a later
      -- captured event creates the alert.  Project the alert independently
      -- on every verified payment event, never only when the payment changed.
      update public.alert_events set viewer_identity_id = identity_id
       where alert_events.payment_id = result.payment_id and alert_events.viewer_identity_id is null;
    end if;
  end if;
  return query select result.duplicate, result.quarantined, result.payment_id,
    result.alert_event_id, result.delivery_status;
end
$$;

revoke execute on function app_private.resolve_anonymous_payment_identity(text) from public;
revoke execute on function app_private.create_payment_order_intent_with_identity(uuid, uuid, text, text, text, bigint, text, text, boolean, timestamptz, text) from public;
revoke execute on function app_private.record_verified_payment_webhook_with_identity(uuid, text, text, text, text, timestamptz, timestamptz, jsonb, uuid, uuid, uuid, uuid, jsonb) from public;
revoke execute on function app_private.sync_creator_supporter_relation_from_payment() from public;
grant execute on function app_private.create_payment_order_intent_with_identity(uuid, uuid, text, text, text, bigint, text, text, boolean, timestamptz, text) to bsa_payment;
grant execute on function app_private.record_verified_payment_webhook_with_identity(uuid, text, text, text, text, timestamptz, timestamptz, jsonb, uuid, uuid, uuid, uuid, jsonb) to bsa_payment;
