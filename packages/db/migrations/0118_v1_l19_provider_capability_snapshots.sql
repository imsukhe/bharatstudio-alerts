-- L19 (Batch 8 reconciliation follow-up): provider_capability_snapshots.
--
-- WHY THIS EXISTS: CreatorPaymentProvider.connectionCapabilities() (see
-- apps/api/src/domain/payment-provider-creator.ts) has always been computed
-- live, on every request, from repo-evidenced facts hardcoded into each
-- provider implementation -- never persisted. That is fine for a single
-- rail with one implementation, but L19's own acceptance criteria requires
-- persisted per-connection capability so a future feature (starting with
-- L17's refund-capability gate) can gate on "what THIS connection was last
-- proven to support" rather than re-deriving it inline everywhere the
-- question comes up. This table is an additive cache/audit trail of what
-- connectionCapabilities() returned, at a point in time, for a specific
-- channel+provider+environment connection -- it is never the source of
-- truth (the live call still is) and nothing reads it to make an
-- authorization decision in this pass; see apps/api/src/routes/
-- payment-accounts.ts for the one write path this migration enables.
--
-- One row per (channel, provider, environment) connection -- upserted, not
-- appended -- because "what can this connection do right now" has exactly
-- one current answer; captured_at is the freshness signal, not a history
-- key. A full history table is not built here: nothing in this task needs
-- one, and adding it later is additive.

create table if not exists public.provider_capability_snapshots (
  id uuid primary key,
  channel_id uuid not null references public.channels(id),
  provider text not null check (provider in ('razorpay')),
  environment text not null check (environment in ('test', 'live')),
  schema_version text not null default 'v1',
  supports_upi_intent boolean not null,
  supports_dynamic_qr boolean not null,
  supports_refunds boolean not null,
  supports_recurring_payments boolean not null,
  supports_cards boolean not null,
  supports_international_payments boolean not null,
  captured_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  unique (channel_id, provider, environment)
);

alter table public.provider_capability_snapshots enable row level security;
revoke all on public.provider_capability_snapshots from public;
revoke all on public.provider_capability_snapshots from bsa_app;
revoke all on public.provider_capability_snapshots from bsa_payment;

-- Read: owner/admin only, same role gate as get_creator_payment_accounts
-- (0060) -- a capability snapshot is exactly as sensitive as the account
-- connection it describes, never public.
create or replace function app_private.get_provider_capability_snapshot(
  target_channel_id uuid,
  target_provider text,
  target_environment text
)
returns table (
  channel_id uuid,
  provider text,
  environment text,
  schema_version text,
  supports_upi_intent boolean,
  supports_dynamic_qr boolean,
  supports_refunds boolean,
  supports_recurring_payments boolean,
  supports_cards boolean,
  supports_international_payments boolean,
  captured_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select snapshot.channel_id, snapshot.provider, snapshot.environment, snapshot.schema_version,
         snapshot.supports_upi_intent, snapshot.supports_dynamic_qr, snapshot.supports_refunds,
         snapshot.supports_recurring_payments, snapshot.supports_cards,
         snapshot.supports_international_payments, snapshot.captured_at, snapshot.updated_at
    from public.provider_capability_snapshots snapshot
   where snapshot.channel_id = target_channel_id
     and snapshot.provider = target_provider
     and snapshot.environment = target_environment
     and app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[])
$$;

-- Write: upsert only, same shape validation the interface itself already
-- enforces in TypeScript (ConnectionCapabilities is a closed boolean set) --
-- re-validated here because a security-definer function must never trust
-- its caller's typing. Gated the same way registration is (0060):
-- owner/admin of the channel this connection belongs to.
create or replace function app_private.upsert_provider_capability_snapshot(
  target_channel_id uuid,
  target_provider text,
  target_environment text,
  target_supports_upi_intent boolean,
  target_supports_dynamic_qr boolean,
  target_supports_refunds boolean,
  target_supports_recurring_payments boolean,
  target_supports_cards boolean,
  target_supports_international_payments boolean
)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  snapshot_id uuid;
begin
  if target_provider not in ('razorpay')
     or target_environment not in ('test', 'live')
     or not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'invalid provider capability snapshot write' using errcode = '42501';
  end if;

  insert into public.provider_capability_snapshots (
    id, channel_id, provider, environment, schema_version,
    supports_upi_intent, supports_dynamic_qr, supports_refunds,
    supports_recurring_payments, supports_cards, supports_international_payments,
    captured_at, updated_at
  ) values (
    gen_random_uuid(), target_channel_id, target_provider, target_environment, 'v1',
    target_supports_upi_intent, target_supports_dynamic_qr, target_supports_refunds,
    target_supports_recurring_payments, target_supports_cards, target_supports_international_payments,
    current_timestamp, current_timestamp
  )
  on conflict (channel_id, provider, environment) do update
    set supports_upi_intent = excluded.supports_upi_intent,
        supports_dynamic_qr = excluded.supports_dynamic_qr,
        supports_refunds = excluded.supports_refunds,
        supports_recurring_payments = excluded.supports_recurring_payments,
        supports_cards = excluded.supports_cards,
        supports_international_payments = excluded.supports_international_payments,
        captured_at = current_timestamp,
        updated_at = current_timestamp
  returning id into snapshot_id;

  return snapshot_id;
end
$$;

revoke execute on function app_private.get_provider_capability_snapshot(uuid, text, text) from public;
revoke execute on function app_private.upsert_provider_capability_snapshot(uuid, text, text, boolean, boolean, boolean, boolean, boolean, boolean) from public;
grant execute on function app_private.get_provider_capability_snapshot(uuid, text, text) to bsa_app;
grant execute on function app_private.upsert_provider_capability_snapshot(uuid, text, text, boolean, boolean, boolean, boolean, boolean, boolean) to bsa_app;
