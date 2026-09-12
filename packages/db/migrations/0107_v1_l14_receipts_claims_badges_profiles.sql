-- L14 missing slices: public no-account receipt page, platform-identity
-- claiming (idempotent, contested-claim-safe), live-derived badges/streaks,
-- and opt-in public profile search. Depends on 0001-0106, rewrites none of
-- them. See tasks/L14-viewer-identity-and-supporter-history.md and master
-- plan Part 8/10.3 item 9 for the requirement this closes.
--
-- DPDP NOTE: this migration asserts no privacy/legal conclusion. It only
-- adds mechanism; see 0085's file header and governance/AGENTS.md.

-- ---------------------------------------------------------------------
-- 1. Receipt entity. TOKEN DESIGN mirrors 0097's TipIntent discipline: the
-- raw token is never stored, only sha256(token) is, and the token itself
-- encodes nothing (pure random, no amount/name payload) — see
-- apps/api/src/db/viewer-profile-store.ts for the alphabet/length/lifetime.
-- Unlike TipIntent this token has NO expiry: a receipt is a permanent
-- record of a real payment, so it lives as long as the payment row does.
-- ---------------------------------------------------------------------
create table payment_receipts (
  id uuid primary key,
  payment_id uuid not null references payments(id),
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default current_timestamp,
  unique (payment_id),
  unique (token_hash)
);

alter table payment_receipts enable row level security;
revoke all on payment_receipts from public;
revoke all on payment_receipts from bsa_app;
-- No policy: every access goes through a SECURITY DEFINER function below,
-- exactly like tip_intents (0097).

-- Idempotent-by-payment mint: a payment can have at most one receipt row
-- (unique(payment_id)). If a receipt already exists, this returns NULL
-- (no row) rather than a second token, so a caller can never mint (or
-- recover) a second valid link for the same payment via this function —
-- the raw token is only ever handed out once, at first mint.
create or replace function app_private.create_payment_receipt(
  target_id uuid,
  target_payment_id uuid,
  target_token_hash text
)
returns table (id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if target_id is null or target_payment_id is null or target_token_hash is null then
    raise exception 'invalid receipt create' using errcode = '22023';
  end if;
  perform 1 from public.payments p where p.id = target_payment_id
    and p.status in ('captured', 'refunded', 'partially_refunded');
  if not found then
    -- No receipt for a payment that never captured: nothing to show a
    -- tipper, and it must not be mintable as a placeholder link.
    return;
  end if;
  insert into public.payment_receipts (id, payment_id, token_hash)
  values (target_id, target_payment_id, target_token_hash)
  on conflict (payment_id) do nothing;
  return query select target_id where exists (
    select 1 from public.payment_receipts r where r.id = target_id and r.payment_id = target_payment_id
  );
end
$$;

-- Public, no-account, no-auth resolution for /r/<token>. Reveals exactly
-- what the tipper gave and to whom — never anything the token itself
-- could have carried (it's a random fingerprint match only). Net amount
-- accounts for processed refunds, same discipline as support goals (0102):
-- live sum, never a stored counter.
create or replace function app_private.get_payment_receipt_by_token_hash(target_token_hash text)
returns table (
  channel_handle text,
  channel_display_name text,
  gross_amount_paise bigint,
  refunded_amount_paise bigint,
  net_amount_paise bigint,
  currency text,
  donor_display_name text,
  message text,
  payment_status text,
  paid_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select c.handle, c.display_name,
         p.gross_amount_paise,
         coalesce((select sum(r.amount_paise) from public.refunds r where r.payment_id = p.id and r.status = 'processed'), 0),
         p.gross_amount_paise - coalesce((select sum(r.amount_paise) from public.refunds r where r.payment_id = p.id and r.status = 'processed'), 0),
         p.currency,
         nullif(poi.donor_display_name, ''),
         nullif(poi.donor_message, ''),
         p.status,
         p.created_at
    from public.payment_receipts receipt
    join public.payments p on p.id = receipt.payment_id
    join public.channels c on c.id = p.channel_id
    left join public.payment_order_intents poi
      on poi.provider = p.provider
     and poi.environment = p.environment
     and poi.connected_account_ref = p.connected_account_ref
     and poi.provider_order_id = p.provider_order_id
   where receipt.token_hash = target_token_hash
$$;

-- Resolves the caller-known payment_order_intents.id (the "orderId" the
-- browser already polls via GET /v1/public/payment-status, see
-- domain/public-payment-status.ts) to the internal payments.id a receipt
-- is minted against. Returns null for an intent that never reached 'paid'
-- — never a payment id for anything the payer didn't actually pay for.
create or replace function app_private.find_payment_id_for_intent(target_intent_id uuid)
returns uuid
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select p.id
    from public.payment_order_intents poi
    join public.payments p
      on p.provider = poi.provider
     and p.environment = poi.environment
     and p.connected_account_ref = poi.connected_account_ref
     and p.provider_order_id = poi.provider_order_id
   where poi.id = target_intent_id
     and poi.status = 'paid'
     and p.status in ('captured', 'refunded', 'partially_refunded')
   limit 1
$$;

revoke execute on function app_private.create_payment_receipt(uuid, uuid, text) from public;
revoke execute on function app_private.get_payment_receipt_by_token_hash(text) from public;
revoke execute on function app_private.find_payment_id_for_intent(uuid) from public;
grant execute on function app_private.create_payment_receipt(uuid, uuid, text) to bsa_app;
grant execute on function app_private.get_payment_receipt_by_token_hash(text) to bsa_app;
grant execute on function app_private.find_payment_id_for_intent(uuid) to bsa_app;

-- ---------------------------------------------------------------------
-- 2/3. Platform-identity claiming, idempotent, contested-claim-safe.
--
-- RULE (contested claim): FIRST-CLAIM-WINS. viewer_identities.merged_
-- into_account_id (0084) is set exactly once, on the first successful
-- claim, and is never overwritten by a later claim from a DIFFERENT
-- account. A repeat claim by the SAME account that already holds it is a
-- no-op success (idempotent). A claim by a different account once it is
-- already held is rejected outright — no re-pointing, no silent merge,
-- and the underlying payment/alert_event rows are never touched (they
-- still point at the original platform viewer_identities.id either way).
--
-- OAuth boundary: this function assumes the caller has ALREADY completed
-- YouTube OAuth verification (L15-owned connector) and is passing a
-- server-verified provider_user_id. It performs no OAuth handshake itself
-- — minting/verifying a YouTube access token is out of this task's
-- boundary (L15 Phase-1 YouTube connector; Twitch/Kick are L15 Phase 2).
-- ---------------------------------------------------------------------
create table viewer_identity_claim_attempts (
  id uuid primary key,
  viewer_platform_identity_id uuid not null references viewer_platform_identities(id),
  viewer_account_id uuid not null references viewer_accounts(id),
  attempted_at timestamptz not null default current_timestamp,
  result text not null check (result in ('claimed', 'already_claimed_by_self', 'rejected_contested'))
);

alter table viewer_identity_claim_attempts enable row level security;
revoke all on viewer_identity_claim_attempts from public;
revoke all on viewer_identity_claim_attempts from bsa_app;

create or replace function app_private.claim_platform_identity(
  target_viewer_account_id uuid,
  target_provider text,
  target_provider_user_id text,
  target_display_name text default null
)
returns table (
  viewer_identity_id uuid,
  claim_result text
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  platform_id uuid;
  identity_row viewer_identities%rowtype;
  outcome text;
begin
  if target_viewer_account_id <> app_private.current_viewer_id() then
    raise exception 'viewer claim access denied' using errcode = '42501';
  end if;
  if not exists (select 1 from viewer_accounts va where va.id = target_viewer_account_id and va.closed_at is null) then
    raise exception 'viewer account not found' using errcode = '42501';
  end if;
  if target_provider is null or target_provider <> 'youtube' or target_provider_user_id is null or length(target_provider_user_id) = 0 then
    raise exception 'invalid platform identity claim' using errcode = '22023';
  end if;

  select id into platform_id
    from viewer_platform_identities
   where provider = target_provider and provider_user_id = target_provider_user_id;

  if platform_id is null then
    -- Never seen this platform identity before: create it AND claim it in
    -- one step, since there is no prior history to contest.
    platform_id := gen_random_uuid();
    insert into viewer_platform_identities (id, provider, provider_user_id, display_name)
    values (platform_id, target_provider, target_provider_user_id, nullif(target_display_name, ''));
    insert into viewer_identities (id, kind, platform_identity_id, merged_into_account_id)
    values (gen_random_uuid(), 'platform', platform_id, target_viewer_account_id)
    returning * into identity_row;
    outcome := 'claimed';
  else
    select * into identity_row from viewer_identities where platform_identity_id = platform_id for update;
    if identity_row.merged_into_account_id is null then
      update viewer_identities set merged_into_account_id = target_viewer_account_id
       where id = identity_row.id
      returning * into identity_row;
      outcome := 'claimed';
    elsif identity_row.merged_into_account_id = target_viewer_account_id then
      outcome := 'already_claimed_by_self';
    else
      outcome := 'rejected_contested';
    end if;
  end if;

  insert into viewer_identity_claim_attempts (id, viewer_platform_identity_id, viewer_account_id, result)
  values (gen_random_uuid(), platform_id, target_viewer_account_id, outcome);

  -- Deliberately returned, not raised: a contested claim is an ordinary,
  -- expected outcome the caller must branch on (routes/viewer.ts maps it
  -- to a 409), not an exceptional condition. Raising here would roll back
  -- the audit insert above in the same statement, destroying the very
  -- record this table exists to keep.
  return query select identity_row.id, outcome;
end
$$;

revoke execute on function app_private.claim_platform_identity(uuid, text, text, text) from public;
grant execute on function app_private.claim_platform_identity(uuid, text, text, text) to bsa_app;

-- ---------------------------------------------------------------------
-- 4. Streaks and badges — computed LIVE from payments minus processed
-- refunds, exactly like support goals (0102): no stored counter exists
-- anywhere in this migration for badge/streak state.
--
-- REFUND RULE: a payment counts toward a badge/streak ONLY while its net
-- remaining amount is > 0. status='refunded' means fully refunded, so
-- such a payment contributes zero tip-count, zero amount and zero streak
-- day everywhere below — a badge earned only by a since-refunded tip
-- disappears the next time it is computed (there is nothing to un-award,
-- because nothing is ever stored). status='partially_refunded' still
-- contributes its net-remaining amount.
--
-- STREAK PROXY: no per-stream-session table exists in this schema (no
-- "streams" table anywhere in packages/db/migrations), so "consecutive
-- stream" is approximated here as consecutive CALENDAR DAYS (viewer's
-- local concept of "supported again next time you streamed" is not
-- resolvable without stream boundaries) with at least one net-positive
-- captured/partially-refunded payment to that channel. This is stated
-- explicitly as a proxy, not asserted as the master-plan's literal
-- per-stream definition.
-- ---------------------------------------------------------------------
create or replace function app_private.get_viewer_channel_badges(
  target_viewer_account_id uuid,
  target_channel_id uuid
)
returns table (
  net_tip_count bigint,
  net_lifetime_paise bigint,
  first_supported_at timestamptz,
  current_streak_days integer,
  badges text[]
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  with my_identities as (
    select vi.id from viewer_identities vi
     where vi.viewer_account_id = target_viewer_account_id
        or vi.merged_into_account_id = target_viewer_account_id
  ),
  net_payments as (
    select p.id, p.created_at,
           p.gross_amount_paise - coalesce((select sum(r.amount_paise) from refunds r where r.payment_id = p.id and r.status = 'processed'), 0) as net_paise
      from payments p
     where p.channel_id = target_channel_id
       and p.viewer_identity_id in (select id from my_identities)
       and p.status in ('captured', 'refunded', 'partially_refunded')
  ),
  positive as (
    select id, created_at, net_paise from net_payments where net_paise > 0
  ),
  days as (
    select distinct (created_at at time zone 'UTC')::date as d from positive
  ),
  streak as (
    -- Longest run of consecutive dates ending at the most recent
    -- supported day: group by (date - row_number) constant-difference,
    -- then take the run that contains max(d).
    select d, d - (row_number() over (order by d))::int as grp
      from days
  ),
  streak_lengths as (
    select grp, count(*) as len, max(d) as last_day from streak group by grp
  ),
  current_run as (
    select len from streak_lengths order by last_day desc limit 1
  ),
  channel_ranks as (
    select p.viewer_identity_id,
           sum(p.gross_amount_paise - coalesce((select sum(r.amount_paise) from refunds r where r.payment_id = p.id and r.status = 'processed'), 0)) as total_net,
           min(p.created_at) as first_at,
           rank() over (order by sum(p.gross_amount_paise - coalesce((select sum(r.amount_paise) from refunds r where r.payment_id = p.id and r.status = 'processed'), 0)) desc) as amount_rank,
           rank() over (order by min(p.created_at) asc) as arrival_rank
      from payments p
     where p.channel_id = target_channel_id
       and p.status in ('captured', 'refunded', 'partially_refunded')
     group by p.viewer_identity_id
    having sum(p.gross_amount_paise - coalesce((select sum(r.amount_paise) from refunds r where r.payment_id = p.id and r.status = 'processed'), 0)) > 0
  )
  select
    (select count(*) from positive)::bigint,
    coalesce((select sum(net_paise) from positive), 0)::bigint,
    (select min(created_at) from positive),
    coalesce((select len from current_run), 0)::int,
    array_remove(array[
      case when (select count(*) from positive) > 0
        then 'supporter_since_' || extract(year from (select min(created_at) from positive))::text
        else null end,
      case when coalesce((select len from current_run), 0) >= 2
        then 'stream_streak_x' || (select len from current_run)::text
        else null end,
      case when exists (
             select 1 from channel_ranks cr join my_identities mi on mi.id = cr.viewer_identity_id
              where cr.arrival_rank <= 10
           ) then 'founding_supporter' else null end,
      case when exists (
             select 1 from channel_ranks cr join my_identities mi on mi.id = cr.viewer_identity_id
              where cr.amount_rank <= 10
           ) then 'top_10_supporter' else null end
    ], null)
$$;

revoke execute on function app_private.get_viewer_channel_badges(uuid, uuid) from public;
grant execute on function app_private.get_viewer_channel_badges(uuid, uuid) to bsa_app;

-- ---------------------------------------------------------------------
-- 5. Opt-in public profile search. NEVER returns a private profile: the
-- where clause on profile_visibility = 'public' is structural, not a
-- caller-supplied filter, and no monetary/amount column is selected here
-- or in the badges function above at all (badges are label strings only).
-- ---------------------------------------------------------------------
create or replace function app_private.search_public_viewer_profiles(query text)
returns table (
  viewer_account_id uuid,
  display_name text,
  profile_slug text
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select va.id, va.display_name, va.profile_slug
    from viewer_accounts va
   where va.profile_visibility = 'public'
     and va.closed_at is null
     and va.profile_slug is not null
     and (
       query is null or length(trim(query)) = 0
       or va.display_name ilike '%' || query || '%'
       or va.profile_slug ilike '%' || query || '%'
     )
   order by va.display_name asc
   limit 25
$$;

create or replace function app_private.get_public_viewer_profile(target_slug text)
returns table (
  viewer_account_id uuid,
  display_name text,
  profile_slug text
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select va.id, va.display_name, va.profile_slug
    from viewer_accounts va
   where lower(va.profile_slug) = lower(target_slug)
     and va.profile_visibility = 'public'
     and va.closed_at is null
$$;

-- Lets a viewer opt in/out and set their own slug. Never callable for
-- another account (current_viewer_id() check, same as every other
-- viewer-scoped function in 0084/0085).
create or replace function app_private.set_viewer_profile_visibility(
  target_viewer_account_id uuid,
  target_visibility text,
  target_slug text
)
returns table (profile_visibility text, profile_slug text)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if target_viewer_account_id <> app_private.current_viewer_id() then
    raise exception 'viewer profile access denied' using errcode = '42501';
  end if;
  if target_visibility not in ('private', 'public') then
    raise exception 'invalid profile visibility' using errcode = '22023';
  end if;
  if target_visibility = 'public' and (target_slug is null or length(trim(target_slug)) < 3) then
    raise exception 'a public profile requires a slug of at least 3 characters' using errcode = '22023';
  end if;
  update viewer_accounts va
     set profile_visibility = target_visibility,
         profile_slug = case when target_visibility = 'public' then lower(trim(target_slug)) else va.profile_slug end,
         updated_at = current_timestamp
   where va.id = target_viewer_account_id;
  return query select va.profile_visibility, va.profile_slug from viewer_accounts va where va.id = target_viewer_account_id;
exception when unique_violation then
  raise exception 'that profile link is already taken' using errcode = '23505';
end
$$;

revoke execute on function app_private.search_public_viewer_profiles(text) from public;
revoke execute on function app_private.get_public_viewer_profile(text) from public;
revoke execute on function app_private.set_viewer_profile_visibility(uuid, text, text) from public;
grant execute on function app_private.search_public_viewer_profiles(text) to bsa_app;
grant execute on function app_private.get_public_viewer_profile(text) to bsa_app;
grant execute on function app_private.set_viewer_profile_visibility(uuid, text, text) to bsa_app;
