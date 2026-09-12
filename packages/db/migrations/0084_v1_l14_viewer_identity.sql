-- L14: viewer identity foundation.
--
-- Three identity strengths, all represented by one discriminated table
-- (viewer_identities) so every downstream join (creator_supporter_relations,
-- payments.viewer_identity_id, alert_events.viewer_identity_id) has a single
-- stable id regardless of strength:
--   anonymous — opaque browser-scoped token, no PII, expiring
--                (anonymous_browser_identities)
--   platform  — OAuth-verified platform user, e.g. YouTube channel UC123
--                (viewer_platform_identities, unique per (provider, provider_user_id))
--   account   — full BharatStudio viewer account, a SEPARATE auth surface
--                (viewer_accounts)
--
-- Separate-vs-shared auth decision: viewer_accounts is a NEW table, not a
-- role/row on app_users. app_users is the creator/team-member surface: every
-- existing RLS policy, channel_memberships row and the 0079 payout-onboarding
-- shape assume "a user is a potential creator/operator of some channel".
-- Overloading it for viewers would force re-auditing every one of those
-- policies to exclude viewer rows, or bolt on a 'viewer_only' flag every
-- future creator-surface query must remember to check. A separate table
-- keeps the blast radius to new code, matches this task's own framing
-- ("a SEPARATE auth surface from the creator account"), and costs nothing
-- extra since no code today shares columns between the two surfaces.
--
-- Claiming an anonymous/platform identity into an account later (task item 8,
-- L15-gated in full) is supported here by design without ever moving or
-- rewriting the original identity row: viewer_identities.merged_into_account_id
-- lets a platform/anonymous identity be *attributed* to an account for
-- dashboard/leaderboard purposes while the original id — and every payment/
-- alert_event row pointing at it — is untouched. This keeps the payment/audit
-- trail immutable even across a later claim.

create table viewer_accounts (
  id uuid primary key,
  email text,
  password_hash text,
  display_name text,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  closed_at timestamptz
);

-- Partial: a closed (DPDP-erased) account has its email nulled out (see
-- 0085) and must not block a new signup from reusing that address.
create unique index viewer_accounts_email_lower_unique
  on viewer_accounts (lower(email)) where closed_at is null and email is not null;

create table anonymous_browser_identities (
  id uuid primary key,
  token_hash text not null,
  created_at timestamptz not null default current_timestamp,
  expires_at timestamptz not null,
  unique (token_hash)
);

create table viewer_platform_identities (
  id uuid primary key,
  provider text not null check (provider in ('youtube')),
  provider_user_id text not null check (char_length(provider_user_id) between 1 and 200),
  display_name text,
  created_at timestamptz not null default current_timestamp,
  unique (provider, provider_user_id)
);

create table viewer_identities (
  id uuid primary key,
  kind text not null check (kind in ('anonymous', 'platform', 'account')),
  anonymous_identity_id uuid references anonymous_browser_identities(id),
  platform_identity_id uuid references viewer_platform_identities(id),
  viewer_account_id uuid references viewer_accounts(id),
  -- Set only on kind in ('anonymous','platform') rows once claimed into an
  -- account (see header comment). Never set on kind='account' rows — those
  -- already *are* the account.
  merged_into_account_id uuid references viewer_accounts(id),
  created_at timestamptz not null default current_timestamp,
  check (
    (kind = 'anonymous' and anonymous_identity_id is not null and platform_identity_id is null and viewer_account_id is null)
    or (kind = 'platform' and platform_identity_id is not null and anonymous_identity_id is null and viewer_account_id is null)
    or (kind = 'account' and viewer_account_id is not null and anonymous_identity_id is null and platform_identity_id is null and merged_into_account_id is null)
  )
);

create unique index viewer_identities_anonymous_unique on viewer_identities (anonymous_identity_id) where anonymous_identity_id is not null;
create unique index viewer_identities_platform_unique on viewer_identities (platform_identity_id) where platform_identity_id is not null;
create unique index viewer_identities_account_unique on viewer_identities (viewer_account_id) where viewer_account_id is not null;
create index viewer_identities_merged_into_idx on viewer_identities (merged_into_account_id) where merged_into_account_id is not null;

-- Per-creator supporter relation: lifetime amount is scoped to (channel_id,
-- viewer_identity_id) ONLY — there is deliberately no table or view anywhere
-- that sums this across channels for a creator's own consumption. The
-- cross-creator sum a viewer sees of themself is computed at read time in
-- app_private.get_viewer_dashboard (0085) via merged_into_account_id, never
-- materialized into a column a creator query could stumble onto.
create table creator_supporter_relations (
  channel_id uuid not null references channels(id),
  viewer_identity_id uuid not null references viewer_identities(id),
  first_supported_at timestamptz not null,
  last_supported_at timestamptz not null,
  lifetime_amount_paise bigint not null default 0 check (lifetime_amount_paise >= 0),
  tip_count bigint not null default 0 check (tip_count >= 0),
  challenge_count bigint not null default 0 check (challenge_count >= 0),
  member_state text not null default 'none' check (member_state in ('none', 'active', 'lapsed')),
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  primary key (channel_id, viewer_identity_id)
);

-- Nullable, backfilled null: existing payment/alert rows are untouched.
alter table payments add column viewer_identity_id uuid references viewer_identities(id);
alter table alert_events add column viewer_identity_id uuid references viewer_identities(id);

alter table viewer_accounts enable row level security;
alter table anonymous_browser_identities enable row level security;
alter table viewer_platform_identities enable row level security;
alter table viewer_identities enable row level security;
alter table creator_supporter_relations enable row level security;
revoke all on viewer_accounts, anonymous_browser_identities, viewer_platform_identities, viewer_identities, creator_supporter_relations from public;
revoke all on viewer_accounts, anonymous_browser_identities, viewer_platform_identities, viewer_identities, creator_supporter_relations from bsa_app;
-- No policies are defined for bsa_app: every access path is a
-- security-definer app_private function (below and in 0085), exactly like
-- app_private.create_user_session / lookup_session for the creator surface.
-- bsa_app has zero direct table grants on these five tables.

create or replace function app_private.current_viewer_id()
returns uuid
language sql stable security invoker
set search_path = pg_catalog, public, app_private
as $$
  select nullif(current_setting('app.viewer_id', true), '')::uuid
$$;

create or replace function app_private.create_viewer_account(
  target_id uuid,
  target_email text,
  target_password_hash text,
  target_display_name text
)
returns table (viewer_account_id uuid, viewer_identity_id uuid)
language plpgsql volatile security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  new_identity_id uuid;
begin
  if target_email is null or target_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'invalid viewer email' using errcode = '22023';
  end if;
  if target_password_hash is null or char_length(target_password_hash) < 20 then
    raise exception 'invalid viewer password hash' using errcode = '22023';
  end if;
  if exists (select 1 from viewer_accounts va where lower(va.email) = lower(target_email) and va.closed_at is null) then
    raise exception 'email already registered' using errcode = '23505';
  end if;
  insert into viewer_accounts (id, email, password_hash, display_name)
  values (target_id, lower(target_email), target_password_hash, nullif(target_display_name, ''));
  new_identity_id := gen_random_uuid();
  insert into viewer_identities (id, kind, viewer_account_id) values (new_identity_id, 'account', target_id);
  return query select target_id, new_identity_id;
end
$$;

create or replace function app_private.find_viewer_account_by_email(target_email text)
returns table (id uuid, password_hash text, closed_at timestamptz)
language sql stable security definer
set search_path = pg_catalog, public, app_private
as $$
  select va.id, va.password_hash, va.closed_at
    from viewer_accounts va
   where lower(va.email) = lower(target_email)
   limit 1
$$;

revoke execute on function app_private.current_viewer_id() from public;
revoke execute on function app_private.create_viewer_account(uuid, text, text, text) from public;
revoke execute on function app_private.find_viewer_account_by_email(text) from public;
grant execute on function app_private.current_viewer_id() to bsa_app;
grant execute on function app_private.create_viewer_account(uuid, text, text, text) to bsa_app;
grant execute on function app_private.find_viewer_account_by_email(text) to bsa_app;
