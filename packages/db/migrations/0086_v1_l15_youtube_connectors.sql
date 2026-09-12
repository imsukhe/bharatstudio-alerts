-- L15: YouTube live-platform connector (v1 scope — see
-- bharatstudio-requirements/tasks/L15-live-platform-connectors-and-chat-commands.md).
-- Only YouTube is built here; Twitch/Kick values are reserved on the widened
-- CHECK so a later batch can add those connector tables without another
-- source_type migration.
--
-- SOURCE_TYPE WIDENING — NON-DESTRUCTIVE.
-- alert_events.source_type currently has an unnamed inline CHECK
-- (source_type in ('payment','manual','companion')) from 0001_v1_baseline.sql.
-- Dropping and re-adding a CHECK with the same clause list plus new values
-- would, if PostgreSQL chose to, revalidate every existing row against the
-- new clause before the ALTER completes and take a long-lived exclusive
-- lock while doing it. Instead this migration adds the widened constraint
-- NOT VALID (a fast operation: only a catalog change, existing rows are
-- not scanned) and then VALIDATEs it in a second statement, which takes a
-- weaker lock and can run concurrently with reads/writes. Every existing
-- row already holds 'payment', 'manual' or 'companion', all of which are
-- still permitted by the new clause, so validation always succeeds and no
-- historical row is rewritten, dropped, or ever at risk of failing the
-- check.
alter table public.alert_events
  drop constraint alert_events_source_type_check;

alter table public.alert_events
  add constraint alert_events_source_type_check
  check (source_type in ('payment', 'manual', 'companion', 'youtube', 'twitch', 'kick'))
  not valid;

alter table public.alert_events
  validate constraint alert_events_source_type_check;

-- Provenance for a normalised external LiveEvent (YouTube Super Chat/Super
-- Sticker/membership now; Twitch/Kick later). Nullable: payment/manual/
-- companion rows never populate these, so no backfill is needed.
alter table public.alert_events
  add column if not exists source_event_type text,
  add column if not exists source_user_id text;

comment on column public.alert_events.source_event_type is
  'External platform''s own event kind (e.g. youtube.super_chat, youtube.super_sticker, youtube.membership_new). Null for payment/manual/companion rows.';
comment on column public.alert_events.source_user_id is
  'External platform''s viewer/user identifier for the event, e.g. YouTube channel ID of the chat author. Null for payment/manual/companion rows.';

-- One-time OAuth state + PKCE verifier, single use, short-lived. Mirrors no
-- existing table (this codebase's only prior OAuth is Google Sign-In,
-- which verifies an id_token and never runs an authorization-code+PKCE
-- flow), so this is new but follows the same security-definer-only access
-- convention as companion_notification_devices (0057).
create table youtube_oauth_states (
  id uuid primary key,
  channel_id uuid not null references channels(id),
  user_id uuid not null references app_users(id),
  state text not null check (state ~ '^[A-Za-z0-9_-]{16,128}$'),
  code_verifier text not null check (code_verifier ~ '^[A-Za-z0-9._~-]{43,128}$'),
  redirect_uri text not null check (char_length(redirect_uri) between 1 and 2048),
  created_at timestamptz not null default current_timestamp,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  unique (state)
);

create index youtube_oauth_states_expiry_idx on youtube_oauth_states (expires_at)
  where consumed_at is null;

-- Per-channel connector. Tokens follow the existing encrypted-token-storage
-- convention used for push-notification device tokens
-- (apps/api/src/notifications/token-crypto.ts, NotificationTokenProtector):
-- ciphertext is `v1.<iv>.<authTag>.<ciphertext>` (base64url, AES-256-GCM)
-- and a separate SHA-256 fingerprint supports idempotent lookups without
-- ever decrypting. No new crypto is introduced by this migration or by the
-- API code that writes these columns.
--
-- unique(channel_id, external_channel_id) intentionally allows more than
-- one row per channel: entitlement (below) counts non-revoked rows per
-- channel and caps at the tier's connector limit, so a Creator/Studio
-- channel can hold multiple distinct external connections once other
-- platform tables exist. Reconnecting the SAME external_channel_id is a
-- token refresh (upsert in place), never counted as a new connector.
create table youtube_channel_connections (
  id uuid primary key,
  channel_id uuid not null references channels(id),
  external_channel_id text not null check (char_length(external_channel_id) between 1 and 64),
  external_channel_title text check (external_channel_title is null or char_length(external_channel_title) between 1 and 256),
  granted_scopes text[] not null default '{}',
  access_token_ciphertext text check (access_token_ciphertext is null or (char_length(access_token_ciphertext) between 32 and 16384 and access_token_ciphertext ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$')),
  access_token_fingerprint text check (access_token_fingerprint is null or access_token_fingerprint ~ '^[0-9a-f]{64}$'),
  refresh_token_ciphertext text check (refresh_token_ciphertext is null or (char_length(refresh_token_ciphertext) between 32 and 16384 and refresh_token_ciphertext ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$')),
  refresh_token_fingerprint text check (refresh_token_fingerprint is null or refresh_token_fingerprint ~ '^[0-9a-f]{64}$'),
  token_expires_at timestamptz,
  status text not null check (status in ('pending', 'active', 'revoked')),
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  revoked_at timestamptz,
  check ((access_token_ciphertext is null) = (access_token_fingerprint is null)),
  check ((refresh_token_ciphertext is null) = (refresh_token_fingerprint is null)),
  unique (channel_id, external_channel_id)
);

create index youtube_channel_connections_channel_idx
  on youtube_channel_connections (channel_id)
  where status <> 'revoked';

alter table youtube_oauth_states enable row level security;
alter table youtube_channel_connections enable row level security;

revoke all on public.youtube_oauth_states from public;
revoke all on public.youtube_channel_connections from public;
revoke all on public.youtube_oauth_states from bsa_app;
revoke all on public.youtube_channel_connections from bsa_app;
revoke all on public.youtube_oauth_states from bsa_payment;
revoke all on public.youtube_channel_connections from bsa_payment;

-- Single source of truth for the connector entitlement (L15 task #11:
-- "one generic External Live Platform Connector count — Free 0, Pro 1,
-- Creator 2, Studio 3"). Same shape as app_private.tier_queue_count
-- (0080): one case statement, same 22023 exception for an unrecognised
-- tier.
create or replace function app_private.youtube_connector_entitlement_limit(target_tier text)
returns integer
language plpgsql
immutable
as $$
begin
  case target_tier
    when 'free' then return 0;
    when 'pro' then return 1;
    when 'creator' then return 2;
    when 'studio' then return 3;
    else raise exception 'unknown entitlement tier: %', target_tier using errcode = '22023';
  end case;
end
$$;

-- Reads the channel's currently-published tier from the existing
-- channel_entitlement_versions table (0001/0070/0080) — no new publish
-- path, no write. Defaults to 'free' only if a channel somehow has no
-- entitlement version yet (should not happen post-0070, but a missing row
-- must never be read as an unlimited/higher tier).
create or replace function app_private.current_channel_tier(target_channel_id uuid)
returns text
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select coalesce(
    (select version.tier
       from public.channel_entitlement_versions version
      where version.channel_id = target_channel_id
      order by version.version desc
      limit 1),
    'free'
  )
$$;

revoke execute on function app_private.current_channel_tier(uuid) from public;
grant execute on function app_private.current_channel_tier(uuid) to bsa_app;

-- Begin OAuth: persists state + PKCE verifier for the callback to consume
-- exactly once. Role-gated the same way payment-account registration is
-- (owner/admin only). This is a fail-fast entitlement hint only — the
-- authoritative check is in finalize_youtube_connection, since tier or
-- connector count can change between connect-click and callback.
create or replace function app_private.begin_youtube_oauth(
  target_state_id uuid,
  target_channel_id uuid,
  target_user_id uuid,
  target_state text,
  target_code_verifier text,
  target_redirect_uri text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  active_count integer;
  tier_limit integer;
begin
  if target_user_id is null
     or target_user_id <> app_private.current_user_id()
     or not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[])
     or target_state_id is null then
    raise exception 'invalid youtube oauth start' using errcode = '42501';
  end if;

  perform 1 from public.channels channel
   where channel.id = target_channel_id and channel.closed_at is null;
  if not found then
    raise exception 'channel not found' using errcode = '42501';
  end if;

  select count(*) into active_count
    from public.youtube_channel_connections connection
   where connection.channel_id = target_channel_id
     and connection.status <> 'revoked';
  tier_limit := app_private.youtube_connector_entitlement_limit(app_private.current_channel_tier(target_channel_id));
  if active_count >= tier_limit then
    raise exception 'youtube connector entitlement limit reached' using errcode = '42501';
  end if;

  insert into public.youtube_oauth_states (
    id, channel_id, user_id, state, code_verifier, redirect_uri, expires_at
  ) values (
    target_state_id, target_channel_id, target_user_id, target_state,
    target_code_verifier, target_redirect_uri, current_timestamp + interval '10 minutes'
  );
  return target_state_id;
end
$$;

-- Single-use state consumption for the OAuth callback. A missing, expired,
-- or already-consumed state raises — the caller (routes/youtube.ts) turns
-- this into an OAuth-state-mismatch rejection.
create or replace function app_private.consume_youtube_oauth_state(target_state text)
returns table (
  channel_id uuid,
  user_id uuid,
  code_verifier text,
  redirect_uri text
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  existing public.youtube_oauth_states%rowtype;
begin
  select oauth_state.* into existing
    from public.youtube_oauth_states oauth_state
   where oauth_state.state = target_state
     and oauth_state.consumed_at is null
     and oauth_state.expires_at > current_timestamp
   for update;
  if not found then
    raise exception 'invalid or expired oauth state' using errcode = '22023';
  end if;

  update public.youtube_oauth_states oauth_state
     set consumed_at = current_timestamp
   where oauth_state.id = existing.id;

  return query select existing.channel_id, existing.user_id, existing.code_verifier, existing.redirect_uri;
end
$$;

-- Finalizes a connector after token exchange. Reconnecting the same
-- external_channel_id is always allowed (token refresh in place); a
-- distinct external_channel_id is only accepted while the channel is under
-- its tier's connector limit.
create or replace function app_private.finalize_youtube_connection(
  target_connection_id uuid,
  target_channel_id uuid,
  target_user_id uuid,
  target_external_channel_id text,
  target_external_channel_title text,
  target_scopes text[],
  target_access_token_ciphertext text,
  target_access_token_fingerprint text,
  target_refresh_token_ciphertext text,
  target_refresh_token_fingerprint text,
  target_token_expires_at timestamptz
)
returns table (
  connection_id uuid,
  external_channel_id text,
  external_channel_title text,
  granted_scopes text[],
  status text,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  existing public.youtube_channel_connections%rowtype;
  had_existing_row boolean;
  active_count integer;
  tier_limit integer;
begin
  if target_user_id is null
     or target_user_id <> app_private.current_user_id()
     or not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[])
     or target_external_channel_id is null then
    raise exception 'invalid youtube connection finalize' using errcode = '42501';
  end if;

  select connection.* into existing
    from public.youtube_channel_connections connection
   where connection.channel_id = target_channel_id
     and connection.external_channel_id = target_external_channel_id
   for update;
  -- Capture FOUND immediately: the entitlement-count/tier-limit selects
  -- below each reset the plpgsql FOUND variable (an aggregate/scalar
  -- select always "finds" a row), so checking FOUND again after them would
  -- read their result, not this select's.
  had_existing_row := found;

  if not had_existing_row or existing.status = 'revoked' then
    select count(*) into active_count
      from public.youtube_channel_connections connection
     where connection.channel_id = target_channel_id
       and connection.status <> 'revoked';
    tier_limit := app_private.youtube_connector_entitlement_limit(app_private.current_channel_tier(target_channel_id));
    if active_count >= tier_limit then
      raise exception 'youtube connector entitlement limit reached' using errcode = '42501';
    end if;
  end if;

  if had_existing_row then
    update public.youtube_channel_connections connection
       set external_channel_title = target_external_channel_title,
           granted_scopes = target_scopes,
           access_token_ciphertext = target_access_token_ciphertext,
           access_token_fingerprint = target_access_token_fingerprint,
           refresh_token_ciphertext = target_refresh_token_ciphertext,
           refresh_token_fingerprint = target_refresh_token_fingerprint,
           token_expires_at = target_token_expires_at,
           status = 'active',
           revoked_at = null,
           updated_at = current_timestamp
     where connection.id = existing.id;
    return query
      select connection.id, connection.external_channel_id, connection.external_channel_title,
             connection.granted_scopes, connection.status, connection.created_at, connection.updated_at
        from public.youtube_channel_connections connection
       where connection.id = existing.id;
    return;
  end if;

  insert into public.youtube_channel_connections (
    id, channel_id, external_channel_id, external_channel_title, granted_scopes,
    access_token_ciphertext, access_token_fingerprint,
    refresh_token_ciphertext, refresh_token_fingerprint,
    token_expires_at, status, created_at, updated_at
  ) values (
    target_connection_id, target_channel_id, target_external_channel_id, target_external_channel_title,
    target_scopes, target_access_token_ciphertext, target_access_token_fingerprint,
    target_refresh_token_ciphertext, target_refresh_token_fingerprint,
    target_token_expires_at, 'active', current_timestamp, current_timestamp
  );
  return query
    select connection.id, connection.external_channel_id, connection.external_channel_title,
           connection.granted_scopes, connection.status, connection.created_at, connection.updated_at
      from public.youtube_channel_connections connection
     where connection.id = target_connection_id;
end
$$;

-- Status read never selects token ciphertext/fingerprint columns — an API
-- response built from this can never leak encrypted token material, let
-- alone plaintext.
create or replace function app_private.get_youtube_connections(target_channel_id uuid)
returns table (
  connection_id uuid,
  external_channel_id text,
  external_channel_title text,
  granted_scopes text[],
  status text,
  created_at timestamptz,
  updated_at timestamptz,
  revoked_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select connection.id, connection.external_channel_id, connection.external_channel_title,
         connection.granted_scopes, connection.status, connection.created_at,
         connection.updated_at, connection.revoked_at
    from public.youtube_channel_connections connection
   where connection.channel_id = target_channel_id
     and app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[])
   order by connection.created_at asc
$$;

-- Revoke degrades to a clean disconnected state: status flips to
-- 'revoked' and both token pairs are cleared in the same statement
-- (defense in depth — a revoked row never carries live token material,
-- even encrypted).
create or replace function app_private.revoke_youtube_connection(
  target_channel_id uuid,
  target_user_id uuid,
  target_connection_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  existing public.youtube_channel_connections%rowtype;
begin
  if target_user_id is null
     or target_user_id <> app_private.current_user_id()
     or not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'invalid youtube connection revoke' using errcode = '42501';
  end if;

  select connection.* into existing
    from public.youtube_channel_connections connection
   where connection.id = target_connection_id
     and connection.channel_id = target_channel_id
     and connection.status <> 'revoked'
   for update;
  if not found then return false; end if;

  update public.youtube_channel_connections connection
     set status = 'revoked',
         revoked_at = current_timestamp,
         updated_at = current_timestamp,
         access_token_ciphertext = null,
         access_token_fingerprint = null,
         refresh_token_ciphertext = null,
         refresh_token_fingerprint = null
   where connection.id = existing.id;
  return true;
end
$$;

revoke execute on function app_private.begin_youtube_oauth(uuid, uuid, uuid, text, text, text) from public;
revoke execute on function app_private.consume_youtube_oauth_state(text) from public;
revoke execute on function app_private.finalize_youtube_connection(uuid, uuid, uuid, text, text, text[], text, text, text, text, timestamptz) from public;
revoke execute on function app_private.get_youtube_connections(uuid) from public;
revoke execute on function app_private.revoke_youtube_connection(uuid, uuid, uuid) from public;

grant execute on function app_private.begin_youtube_oauth(uuid, uuid, uuid, text, text, text) to bsa_app;
grant execute on function app_private.consume_youtube_oauth_state(text) to bsa_app;
grant execute on function app_private.finalize_youtube_connection(uuid, uuid, uuid, text, text, text[], text, text, text, text, timestamptz) to bsa_app;
grant execute on function app_private.get_youtube_connections(uuid) to bsa_app;
grant execute on function app_private.revoke_youtube_connection(uuid, uuid, uuid) to bsa_app;
