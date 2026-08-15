-- L07 Companion notification registration and preferences.
--
-- Push tokens are bearer credentials. Store only encrypted token material and
-- a one-way fingerprint for idempotent registration. Notification payloads
-- are intentionally limited to connection/security/action-failure categories;
-- tip, donor and payment data must never be sent through this channel.

create table companion_notification_preferences (
  user_id uuid primary key references app_users(id),
  connection_alerts boolean not null default true,
  security_alerts boolean not null default true,
  action_failures boolean not null default false,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp
);

create table companion_notification_devices (
  id uuid primary key,
  user_id uuid not null references app_users(id),
  platform text not null check (platform in ('ios', 'android')),
  token_ciphertext text not null check (char_length(token_ciphertext) between 32 and 16384),
  token_fingerprint text not null check (token_fingerprint ~ '^[0-9a-f]{64}$'),
  enabled boolean not null default true,
  created_at timestamptz not null default current_timestamp,
  last_seen_at timestamptz not null default current_timestamp,
  revoked_at timestamptz,
  unique (user_id, token_fingerprint)
);

create index companion_notification_devices_user_idx
  on companion_notification_devices (user_id, last_seen_at desc)
  where revoked_at is null;

alter table companion_notification_preferences enable row level security;
alter table companion_notification_devices enable row level security;

revoke all on public.companion_notification_preferences from public;
revoke all on public.companion_notification_devices from public;
revoke all on public.companion_notification_preferences from bsa_app;
revoke all on public.companion_notification_devices from bsa_app;

create or replace function app_private.get_notification_preferences()
returns table (connection_alerts boolean, security_alerts boolean, action_failures boolean)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if app_private.current_user_id() is null then
    raise exception 'notification preferences require an authenticated user' using errcode = '42501';
  end if;
  insert into public.companion_notification_preferences (user_id)
  values (app_private.current_user_id())
  on conflict (user_id) do nothing;
  return query
    select preferences.connection_alerts, preferences.security_alerts, preferences.action_failures
      from public.companion_notification_preferences preferences
     where preferences.user_id = app_private.current_user_id();
end
$$;

create or replace function app_private.set_notification_preferences(
  target_connection_alerts boolean,
  target_security_alerts boolean,
  target_action_failures boolean
)
returns table (connection_alerts boolean, security_alerts boolean, action_failures boolean)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if app_private.current_user_id() is null then
    raise exception 'notification preferences require an authenticated user' using errcode = '42501';
  end if;
  insert into public.companion_notification_preferences (
    user_id, connection_alerts, security_alerts, action_failures, created_at, updated_at
  ) values (
    app_private.current_user_id(), target_connection_alerts, target_security_alerts,
    target_action_failures, current_timestamp, current_timestamp
  )
  on conflict (user_id) do update
    set connection_alerts = excluded.connection_alerts,
        security_alerts = excluded.security_alerts,
        action_failures = excluded.action_failures,
        updated_at = current_timestamp;
  return query
    select preferences.connection_alerts, preferences.security_alerts, preferences.action_failures
      from public.companion_notification_preferences preferences
     where preferences.user_id = app_private.current_user_id();
end
$$;

create or replace function app_private.register_notification_device(
  target_platform text,
  target_token_ciphertext text,
  target_token_fingerprint text
)
returns table (device_id uuid, platform text, enabled boolean, created_at timestamptz, last_seen_at timestamptz)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  result public.companion_notification_devices%rowtype;
begin
  if app_private.current_user_id() is null
     or target_platform not in ('ios', 'android')
     or target_token_ciphertext !~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
     or char_length(target_token_ciphertext) > 16384
     or target_token_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid notification device registration' using errcode = '22023';
  end if;

  insert into public.companion_notification_devices (
    id, user_id, platform, token_ciphertext, token_fingerprint,
    enabled, created_at, last_seen_at, revoked_at
  ) values (
    gen_random_uuid(), app_private.current_user_id(), target_platform,
    target_token_ciphertext, target_token_fingerprint,
    true, current_timestamp, current_timestamp, null
  )
  on conflict (user_id, token_fingerprint) do update
    set platform = excluded.platform,
        token_ciphertext = excluded.token_ciphertext,
        enabled = true,
        last_seen_at = current_timestamp,
        revoked_at = null
  returning * into result;

  return query select result.id, result.platform, result.enabled, result.created_at, result.last_seen_at;
end
$$;

create or replace function app_private.list_notification_devices()
returns table (device_id uuid, platform text, enabled boolean, created_at timestamptz, last_seen_at timestamptz)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select device.id, device.platform, device.enabled, device.created_at, device.last_seen_at
    from public.companion_notification_devices device
   where device.user_id = app_private.current_user_id()
     and device.revoked_at is null
   order by device.last_seen_at desc, device.id asc
$$;

create or replace function app_private.revoke_notification_device(target_device_id uuid)
returns boolean
language sql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
  update public.companion_notification_devices device
     set enabled = false, revoked_at = current_timestamp
   where device.id = target_device_id
     and device.user_id = app_private.current_user_id()
     and device.revoked_at is null
  returning true
$$;

revoke execute on function app_private.get_notification_preferences() from public;
revoke execute on function app_private.set_notification_preferences(boolean, boolean, boolean) from public;
revoke execute on function app_private.register_notification_device(text, text, text) from public;
revoke execute on function app_private.list_notification_devices() from public;
revoke execute on function app_private.revoke_notification_device(uuid) from public;
grant execute on function app_private.get_notification_preferences() to bsa_app;
grant execute on function app_private.set_notification_preferences(boolean, boolean, boolean) to bsa_app;
grant execute on function app_private.register_notification_device(text, text, text) to bsa_app;
grant execute on function app_private.list_notification_devices() to bsa_app;
grant execute on function app_private.revoke_notification_device(uuid) to bsa_app;
