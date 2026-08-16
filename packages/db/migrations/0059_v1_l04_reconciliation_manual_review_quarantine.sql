-- L04: durable manual-review quarantine for provider states that cannot be
-- safely reconciled automatically. Quarantine is not deletion and does not
-- rewrite payment/refund evidence.

create table if not exists public.payment_reconciliation_manual_reviews (
  id uuid primary key,
  kind text not null check (kind in ('payment', 'refund')),
  target_id uuid not null,
  reason text not null check (char_length(reason) between 1 and 500),
  status text not null check (status in ('open', 'resolved', 'rejected')) default 'open',
  first_seen_at timestamptz not null default current_timestamp,
  last_seen_at timestamptz not null default current_timestamp,
  resolved_at timestamptz,
  resolved_by text,
  resolution_note text,
  unique (kind, id)
);

create unique index if not exists payment_reconciliation_manual_reviews_open_target_idx
  on public.payment_reconciliation_manual_reviews (kind, target_id)
  where status = 'open';

create index if not exists payment_reconciliation_manual_reviews_status_idx
  on public.payment_reconciliation_manual_reviews (status, last_seen_at);

alter table public.payment_reconciliation_manual_reviews enable row level security;
revoke all on public.payment_reconciliation_manual_reviews from public;
revoke all on public.payment_reconciliation_manual_reviews from bsa_app;
revoke all on public.payment_reconciliation_manual_reviews from bsa_payment;

create or replace function app_private.quarantine_payment_reconciliation(
  target_intent_id uuid,
  target_reason text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if target_intent_id is null or target_reason is null or char_length(target_reason) = 0 then
    raise exception 'invalid payment manual-review request' using errcode = '22023';
  end if;

  insert into public.payment_reconciliation_manual_reviews (
    id, kind, target_id, reason, status, first_seen_at, last_seen_at
  ) values (
    gen_random_uuid(), 'payment', target_intent_id, left(target_reason, 500), 'open',
    current_timestamp, current_timestamp
  )
  on conflict (kind, target_id) where status = 'open'
  do update set reason = excluded.reason, last_seen_at = current_timestamp;
  return true;
end
$$;

create or replace function app_private.quarantine_refund_reconciliation(
  target_refund_id uuid,
  target_reason text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if target_refund_id is null or target_reason is null or char_length(target_reason) = 0 then
    raise exception 'invalid refund manual-review request' using errcode = '22023';
  end if;

  insert into public.payment_reconciliation_manual_reviews (
    id, kind, target_id, reason, status, first_seen_at, last_seen_at
  ) values (
    gen_random_uuid(), 'refund', target_refund_id, left(target_reason, 500), 'open',
    current_timestamp, current_timestamp
  )
  on conflict (kind, target_id) where status = 'open'
  do update set reason = excluded.reason, last_seen_at = current_timestamp;
  return true;
end
$$;

create or replace function app_private.resolve_reconciliation_manual_review(
  target_kind text,
  target_record_id uuid,
  target_status text,
  target_actor text,
  target_note text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if target_kind not in ('payment', 'refund')
     or target_record_id is null
     or target_status not in ('resolved', 'rejected')
     or target_actor is null or char_length(target_actor) = 0 then
    raise exception 'invalid manual-review resolution' using errcode = '22023';
  end if;

  update public.payment_reconciliation_manual_reviews review
     set status = target_status,
         resolved_at = current_timestamp,
         resolved_by = left(target_actor, 160),
         resolution_note = left(coalesce(target_note, ''), 500),
         last_seen_at = current_timestamp
   where review.kind = target_kind and review.target_id = target_record_id and review.status = 'open';
  return found;
end
$$;

drop function if exists app_private.list_payment_reconciliation_candidates(integer);
create function app_private.list_payment_reconciliation_candidates(
  target_limit integer
)
returns table (
  intent_id uuid,
  connected_account_ref text,
  provider_order_id text,
  provider_receipt text,
  amount_paise bigint,
  currency text,
  status text,
  expires_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select intent.id, intent.connected_account_ref, intent.provider_order_id,
         intent.provider_receipt, intent.gross_amount_paise, intent.currency,
         intent.status, intent.expires_at
    from public.payment_order_intents intent
   where intent.provider = 'razorpay'
     and intent.provider_order_id is not null
     and intent.status in ('provider_pending', 'provider_created')
     and not exists (
       select 1 from public.payment_reconciliation_manual_reviews review
        where review.kind = 'payment'
          and review.target_id = intent.id
          and review.status = 'open'
     )
   order by intent.updated_at asc, intent.id asc
   limit greatest(1, least(coalesce(target_limit, 1), 500))
$$;

drop function if exists app_private.list_refund_reconciliation_candidates(integer);
create function app_private.list_refund_reconciliation_candidates(
  target_limit integer
)
returns table (
  refund_id uuid,
  connected_account_ref text,
  provider_refund_id text,
  provider_payment_id text,
  amount_paise bigint,
  currency text,
  status text
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select refund.id, payment.connected_account_ref,
         refund.provider_refund_id, payment.provider_payment_id,
         refund.amount_paise, payment.currency, refund.status
    from public.refunds refund
    join public.payments payment on payment.id = refund.payment_id
   where payment.provider = 'razorpay'
     and refund.status = 'requested'
     and not exists (
       select 1 from public.payment_reconciliation_manual_reviews review
        where review.kind = 'refund'
          and review.target_id = refund.id
          and review.status = 'open'
     )
   order by refund.updated_at asc, refund.id asc
   limit greatest(1, least(coalesce(target_limit, 1), 500))
$$;

revoke execute on function app_private.quarantine_payment_reconciliation(uuid, text) from public;
revoke execute on function app_private.quarantine_refund_reconciliation(uuid, text) from public;
revoke execute on function app_private.resolve_reconciliation_manual_review(text, uuid, text, text, text) from public;
revoke execute on function app_private.list_payment_reconciliation_candidates(integer) from public;
revoke execute on function app_private.list_refund_reconciliation_candidates(integer) from public;
grant execute on function app_private.quarantine_payment_reconciliation(uuid, text) to bsa_payment;
grant execute on function app_private.quarantine_refund_reconciliation(uuid, text) to bsa_payment;
grant execute on function app_private.resolve_reconciliation_manual_review(text, uuid, text, text, text) to bsa_payment;
grant execute on function app_private.list_payment_reconciliation_candidates(integer) to bsa_payment;
grant execute on function app_private.list_refund_reconciliation_candidates(integer) to bsa_payment;
