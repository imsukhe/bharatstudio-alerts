-- L15 task 7/8/17: TipIntent + opaque short link (10.3 item 17).
-- A viewer's `!tip [amount] [message]` becomes a server-side TipIntent
-- keyed by an opaque token; the token is what travels through chat and the
-- /t/<token> confirmation page (apps/web/app/t/**), never the amount,
-- display name, or message. Depends on 0001-0096, modifies none of them.
--
-- TOKEN DESIGN. The token itself is never stored — only sha256(token) is,
-- exactly like youtube_channel_connections' access_token_fingerprint
-- (0094): a leaked database row can never be replayed as a live token, and
-- a lookup is a plain indexed equality match. The token's own alphabet and
-- length are chosen and generated in apps/api (db/tipintent-store.ts) —
-- this migration only stores and matches the fingerprint.
create table public.tip_intents (
  id uuid primary key,
  channel_id uuid not null references public.channels(id),
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  amount_paise integer not null check (amount_paise between 100 and 10000000),
  currency text not null default 'INR' check (currency = 'INR'),
  donor_display_name text check (donor_display_name is null or char_length(donor_display_name) <= 80),
  message text check (message is null or char_length(message) <= 500),
  source_platform text not null check (source_platform in ('youtube')),
  source_channel_user_id text check (source_channel_user_id is null or char_length(source_channel_user_id) <= 128),
  order_id uuid,
  created_at timestamptz not null default current_timestamp,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  unique (token_hash)
);

create index tip_intents_channel_idx on public.tip_intents (channel_id, created_at desc);
-- Supports a cheap periodic cleanup of long-expired, never-consumed rows
-- without a table scan; no cleanup job is added by this migration.
create index tip_intents_expiry_idx on public.tip_intents (expires_at) where consumed_at is null;

alter table public.tip_intents enable row level security;
-- No policy is created: exactly like youtube_oauth_states/
-- youtube_channel_connections (0094), every access goes through a
-- SECURITY DEFINER function below, which is exempt from RLS as the table
-- owner. No role — not even bsa_app — gets a raw grant on this table.
revoke all on public.tip_intents from public;
revoke all on public.tip_intents from bsa_app;
revoke all on public.tip_intents from bsa_payment;

-- Creates a TipIntent. Called from apps/api's internal (shared-secret
-- protected, not end-user-authenticated) tip-intent creation route — see
-- routes/public.ts. expires_at is computed here, not trusted from the
-- caller, so a caller cannot mint a long-lived token by passing a distant
-- expiry.
create or replace function app_private.create_tip_intent(
  target_id uuid,
  target_channel_id uuid,
  target_token_hash text,
  target_amount_paise integer,
  target_donor_display_name text,
  target_message text,
  target_source_platform text,
  target_source_channel_user_id text,
  target_ttl_minutes integer default 30
)
returns table (id uuid, expires_at timestamptz)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  computed_expiry timestamptz;
begin
  if target_id is null or target_channel_id is null or target_token_hash is null
     or target_amount_paise is null or target_source_platform is null
     or target_ttl_minutes is null or target_ttl_minutes <= 0 or target_ttl_minutes > 180 then
    raise exception 'invalid tip intent create' using errcode = '22023';
  end if;
  perform 1 from public.channels channel where channel.id = target_channel_id and channel.closed_at is null;
  if not found then
    raise exception 'channel not found' using errcode = '22023';
  end if;

  computed_expiry := current_timestamp + make_interval(mins => target_ttl_minutes);

  insert into public.tip_intents (
    id, channel_id, token_hash, amount_paise, donor_display_name, message,
    source_platform, source_channel_user_id, created_at, expires_at
  ) values (
    target_id, target_channel_id, target_token_hash, target_amount_paise,
    nullif(target_donor_display_name, ''), nullif(target_message, ''),
    target_source_platform, target_source_channel_user_id, current_timestamp, computed_expiry
  );

  return query select target_id, computed_expiry;
end
$$;

-- Read-only resolution for the /t/<token> page. Returns a computed
-- `state` — 'ready' | 'used' | 'expired' — never a raw boolean the caller
-- has to re-derive, so the three states routes/public.ts and the page must
-- render distinctly are decided in exactly one place. Never returns rows
-- for a token that never existed at all (the caller distinguishes "no
-- rows" as 'unknown').
create or replace function app_private.get_tip_intent_by_token_hash(target_token_hash text)
returns table (
  id uuid,
  channel_id uuid,
  channel_handle text,
  channel_display_name text,
  amount_paise integer,
  currency text,
  donor_display_name text,
  message text,
  state text
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  -- amount_paise/donor_display_name/message are nulled out here (not left
  -- for the caller to remember to hide) whenever state is not 'ready' —
  -- defense in depth: a used or expired TipIntent can never leak what was
  -- being tipped, even if a future caller forgets to filter on state.
  select intent.id, intent.channel_id, channel.handle, channel.display_name,
         case when state.value = 'ready' then intent.amount_paise else null end as amount_paise,
         intent.currency,
         case when state.value = 'ready' then intent.donor_display_name else null end as donor_display_name,
         case when state.value = 'ready' then intent.message else null end as message,
         state.value as state
    from public.tip_intents intent
    join public.channels channel on channel.id = intent.channel_id
    cross join lateral (
      select case
               when intent.consumed_at is not null then 'used'
               when intent.expires_at <= current_timestamp then 'expired'
               else 'ready'
             end as value
    ) state
   where intent.token_hash = target_token_hash
$$;

-- Atomically consumes a ready TipIntent, recording the resulting tip
-- order's id. Returns no row when the token is unknown, already used, or
-- expired — the caller (routes/public.ts) turns "no row" into the correct
-- 409/410-shaped response and never trusts a client-supplied amount for
-- this path, since the amount/message returned here are the only ones
-- ever used to create the order.
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
     and intent.consumed_at is null
     and intent.expires_at > current_timestamp
   for update;
  if not found then
    return;
  end if;

  update public.tip_intents intent
     set consumed_at = current_timestamp, order_id = target_order_id
   where intent.id = existing.id;

  return query select existing.id, existing.channel_id, existing.amount_paise, existing.currency,
                      existing.donor_display_name, existing.message;
end
$$;

revoke execute on function app_private.create_tip_intent(uuid, uuid, text, integer, text, text, text, text, integer) from public;
revoke execute on function app_private.get_tip_intent_by_token_hash(text) from public;
revoke execute on function app_private.consume_tip_intent(text, uuid) from public;

grant execute on function app_private.create_tip_intent(uuid, uuid, text, integer, text, text, text, text, integer) to bsa_app;
grant execute on function app_private.get_tip_intent_by_token_hash(text) to bsa_app;
grant execute on function app_private.consume_tip_intent(text, uuid) to bsa_app;
