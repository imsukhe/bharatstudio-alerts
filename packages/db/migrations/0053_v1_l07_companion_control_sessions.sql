-- L07 server-owned Companion control-session leases.
--
-- A control session is an operational lease only. It never gates or mutates
-- payment receipt, webhook persistence, alert queues, outbox rows or delivery
-- state. Free channels have one active lease; paid-channel concurrency remains
-- an entitlement decision rather than an implicit client-side permission.

create table companion_control_sessions (
  id uuid primary key,
  channel_id uuid not null references channels(id),
  user_id uuid not null references app_users(id),
  client_type text not null check (client_type in ('web', 'mobile', 'desktop')),
  client_instance_id text not null check (client_instance_id ~ '^[A-Za-z0-9._:-]{16,128}$'),
  lease_until timestamptz not null,
  revoked_at timestamptz,
  revoked_reason text,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create index companion_control_sessions_active_idx
  on companion_control_sessions (channel_id, lease_until)
  where revoked_at is null;

create unique index companion_control_sessions_active_identity_idx
  on companion_control_sessions (channel_id, user_id, client_type, client_instance_id)
  where revoked_at is null;

alter table companion_control_sessions enable row level security;

create policy companion_control_sessions_member_select
  on companion_control_sessions for select to bsa_app
  using (app_private.can_access_channel(channel_id));

revoke all on public.companion_control_sessions from public;
revoke insert, update, delete on public.companion_control_sessions from bsa_app;
grant select on public.companion_control_sessions to bsa_app;

create or replace function app_private.acquire_companion_control_session(
  target_session_id uuid,
  target_channel_id uuid,
  target_user_id uuid,
  target_client_type text,
  target_client_instance_id text,
  target_lease_until timestamptz
)
returns table (
  session_id uuid,
  channel_id uuid,
  client_type text,
  client_instance_id text,
  lease_until timestamptz,
  created_at timestamptz,
  reused boolean
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  current_tier text;
  existing companion_control_sessions%rowtype;
begin
  if target_user_id <> app_private.current_user_id()
     or target_session_id is null
     or target_channel_id is null
     or target_client_type not in ('web', 'mobile', 'desktop')
     or target_client_instance_id !~ '^[A-Za-z0-9._:-]{16,128}$'
     or target_lease_until < current_timestamp + interval '30 seconds'
     or target_lease_until > current_timestamp + interval '15 minutes' then
    raise exception 'invalid Companion control session' using errcode = '22023';
  end if;
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin', 'operator']::text[]) then
    raise exception 'Companion control access denied' using errcode = '42501';
  end if;

  -- Serialize expiry, reuse and Free-tier admission per channel. This is
  -- transaction-scoped and safe on transaction-pooled connections.
  perform 1 from public.channels channel
   where channel.id = target_channel_id and channel.closed_at is null
   for update;
  if not found then
    raise exception 'channel not found' using errcode = '42501';
  end if;

  update public.companion_control_sessions session
     set revoked_at = current_timestamp,
         revoked_reason = 'lease_expired',
         updated_at = current_timestamp
   where session.channel_id = target_channel_id
     and session.revoked_at is null
     and session.lease_until <= current_timestamp;

  select session.*
    into existing
    from public.companion_control_sessions session
   where session.channel_id = target_channel_id
     and session.user_id = target_user_id
     and session.client_type = target_client_type
     and session.client_instance_id = target_client_instance_id
     and session.revoked_at is null
   for update;
  if found then
    update public.companion_control_sessions session
       set lease_until = target_lease_until,
           updated_at = current_timestamp
     where session.id = existing.id
     returning session.id, session.channel_id, session.client_type,
               session.client_instance_id, session.lease_until,
               session.created_at
      into session_id, channel_id, client_type, client_instance_id,
           lease_until, created_at;
    reused := true;
    return next;
    return;
  end if;

  select coalesce((select entitlement.tier
                     from public.channel_entitlement_versions entitlement
                    where entitlement.channel_id = target_channel_id
                    order by entitlement.version desc limit 1), 'free')
    into current_tier;
  if current_tier = 'free' and exists (
    select 1 from public.companion_control_sessions session
     where session.channel_id = target_channel_id
       and session.revoked_at is null
       and session.lease_until > current_timestamp
  ) then
    raise exception 'free Companion control session already active' using errcode = '55P03';
  end if;

  insert into public.companion_control_sessions (
    id, channel_id, user_id, client_type, client_instance_id,
    lease_until, created_at, updated_at
  ) values (
    target_session_id, target_channel_id, target_user_id, target_client_type,
    target_client_instance_id, target_lease_until, current_timestamp,
    current_timestamp
  )
  returning companion_control_sessions.id,
            companion_control_sessions.channel_id,
            companion_control_sessions.client_type,
            companion_control_sessions.client_instance_id,
            companion_control_sessions.lease_until,
            companion_control_sessions.created_at
       into session_id, channel_id, client_type, client_instance_id,
            lease_until, created_at;
  reused := false;
  return next;
end
$$;

drop function if exists app_private.revoke_companion_control_session(uuid, uuid, text);

create or replace function app_private.revoke_companion_control_session(
  target_session_id uuid,
  target_channel_id uuid,
  target_user_id uuid,
  target_reason text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if target_user_id <> app_private.current_user_id()
     or target_session_id is null
     or target_channel_id is null
     or char_length(coalesce(target_reason, '')) > 120 then
    raise exception 'invalid Companion control revocation' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.companion_control_sessions session
     where session.id = target_session_id
       and session.channel_id = target_channel_id
       and app_private.has_channel_role(session.channel_id, array['owner', 'admin', 'operator']::text[])
  ) then
    raise exception 'Companion control access denied' using errcode = '42501';
  end if;
  update public.companion_control_sessions
     set revoked_at = current_timestamp,
         revoked_reason = coalesce(nullif(target_reason, ''), 'user_revoked'),
         updated_at = current_timestamp
   where id = target_session_id and revoked_at is null;
  return found;
end
$$;

revoke execute on function app_private.acquire_companion_control_session(uuid, uuid, uuid, text, text, timestamptz) from public;
revoke execute on function app_private.revoke_companion_control_session(uuid, uuid, uuid, text) from public;
grant execute on function app_private.acquire_companion_control_session(uuid, uuid, uuid, text, text, timestamptz) to bsa_app;
grant execute on function app_private.revoke_companion_control_session(uuid, uuid, uuid, text) to bsa_app;
