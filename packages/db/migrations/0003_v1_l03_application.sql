-- BharatStudio Alerts v1 L03 application persistence — DRAFT, DO NOT RUN.
--
-- Depends on 0001_v1_baseline.sql and 0002_v1_security_rls_archive.sql.
-- This migration is a clean-environment artifact only. Production role
-- ownership, grants and deployment approval remain separate gates.

create table user_sessions (
  id uuid primary key,
  user_id uuid not null references app_users(id),
  token_hash text not null unique,
  device_label text not null,
  created_at timestamptz not null,
  last_seen_at timestamptz not null,
  expires_at timestamptz not null,
  revoked_at timestamptz
);

create index user_sessions_user_active_idx
  on user_sessions (user_id, revoked_at, expires_at);

create table channel_configs (
  channel_id uuid not null references channels(id),
  version bigint not null,
  values jsonb not null,
  effective_at timestamptz not null,
  created_at timestamptz not null,
  primary key (channel_id, version)
);

create table queue_bindings (
  id uuid primary key,
  channel_id uuid not null references channels(id),
  queue_id uuid not null references alert_queues(id),
  source_type text not null check (source_type in ('payment', 'manual', 'companion')),
  source_id text not null,
  allow_duplicates boolean not null,
  priority integer not null check (priority between 0 and 100000),
  override_values jsonb,
  created_at timestamptz not null,
  closed_at timestamptz,
  unique (queue_id, source_type, source_id)
);

-- `__channel_default__` is the reserved source ID for a channel-wide
-- payment binding. Exact provider payment IDs take precedence over this
-- fallback. It lets a channel route a new payment before its provider ID
-- exists, without weakening source-specific routing.

create index queue_bindings_channel_active_idx
  on queue_bindings (channel_id, closed_at);

create table alert_moderation_actions (
  id uuid primary key,
  event_id uuid not null references alert_events(id),
  channel_id uuid not null references channels(id),
  actor_user_id uuid not null references app_users(id),
  action text not null check (action in ('approve', 'hold', 'suppress', 'replay')),
  reason text,
  created_at timestamptz not null
);

create table companion_commands (
  id uuid primary key,
  channel_id uuid not null references channels(id),
  actor_user_id uuid not null references app_users(id),
  idempotency_key text not null,
  action text not null check (action in ('pause_queue', 'resume_queue', 'approve_alert', 'hold_alert', 'replay_alert', 'send_test_alert')),
  target_id text,
  status text not null check (status in ('accepted', 'rejected')),
  created_at timestamptz not null,
  unique (channel_id, idempotency_key)
);

-- Authentication creates a session only after the API verifies the Google
-- identity. The API supplies cryptographically random IDs and a SHA-256 token
-- hash; the database never stores an access token.
create or replace function app_private.create_user_session(
  target_user_id uuid,
  target_external_subject text,
  target_display_name text,
  target_token_hash text,
  target_device_label text,
  target_expires_at timestamptz,
  target_session_id uuid
)
returns table (user_id uuid, session_id uuid, expires_at timestamptz)
language sql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
  with upserted_user as (
    insert into public.app_users (id, external_subject, display_name, created_at, updated_at)
    values (target_user_id, target_external_subject, target_display_name, current_timestamp, current_timestamp)
    on conflict (external_subject) do update
      set display_name = coalesce(excluded.display_name, app_users.display_name),
          updated_at = current_timestamp
    returning id
  ), inserted_session as (
    insert into public.user_sessions (id, user_id, token_hash, device_label, created_at, last_seen_at, expires_at)
    select target_session_id, upserted_user.id, target_token_hash, target_device_label,
           current_timestamp, current_timestamp, target_expires_at
      from upserted_user
    returning user_id, id, expires_at
  )
  select inserted_session.user_id, inserted_session.id, inserted_session.expires_at
    from inserted_session
$$;

create or replace function app_private.lookup_session(target_token_hash text)
returns table (session_id uuid, user_id uuid, expires_at timestamptz)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select session.id, session.user_id, session.expires_at
    from public.user_sessions session
   where session.token_hash = target_token_hash
     and session.revoked_at is null
     and session.expires_at > current_timestamp
   limit 1
$$;

create or replace function app_private.create_channel(
  target_channel_id uuid,
  target_user_id uuid,
  target_handle text,
  target_display_name text
)
returns table (channel_id uuid)
language sql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
  with inserted_channel as (
    insert into public.channels (id, owner_user_id, handle, display_name, created_at, updated_at)
    values (target_channel_id, target_user_id, target_handle, target_display_name, current_timestamp, current_timestamp)
    returning id
  ), inserted_membership as (
    insert into public.channel_memberships (channel_id, user_id, role, created_at)
    select inserted_channel.id, target_user_id, 'owner', current_timestamp
      from inserted_channel
    returning channel_id
  ), inserted_config as (
    insert into public.channel_configs (channel_id, version, values, effective_at, created_at)
    select inserted_channel.id, 1, '{}'::jsonb, current_timestamp, current_timestamp
      from inserted_channel
    returning channel_id
  ), inserted_entitlement as (
    insert into public.channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at)
    select inserted_channel.id, 1, 'free', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp
      from inserted_channel
    returning channel_id
  )
  select channel_id from inserted_membership
$$;

create or replace function app_private.create_manual_alert(
  target_event_id uuid,
  target_outbox_id uuid,
  target_channel_id uuid,
  target_user_id uuid,
  target_trace_id text,
  target_config_snapshot_version bigint,
  target_payload jsonb
)
returns table (event_id uuid, trace_id text)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if target_user_id <> app_private.current_user_id() then
    raise exception 'actor mismatch' using errcode = '42501';
  end if;
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin', 'operator', 'moderator']::text[]) then
    raise exception 'channel access denied' using errcode = '42501';
  end if;

  insert into public.alert_events (id, channel_id, payment_id, source_type, source_id, trace_id, config_snapshot_version, payload, created_at)
  values (target_event_id, target_channel_id, null, 'manual', target_event_id::text, target_trace_id, target_config_snapshot_version, target_payload, current_timestamp);

  insert into public.event_outbox (id, event_id, status, available_at, created_at, updated_at)
  values (target_outbox_id, target_event_id, 'pending', current_timestamp, current_timestamp, current_timestamp);

  return query select target_event_id, target_trace_id;
end
$$;

create or replace function app_private.get_alert_history(
  target_channel_id uuid,
  target_cursor timestamptz,
  target_limit integer
)
returns table (
  event_id uuid,
  source_type text,
  status text,
  created_at timestamptz,
  gross_amount_paise bigint,
  currency text,
  display_name text,
  message text
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select event.id,
         event.source_type,
         case
           when outbox.status = 'completed' then 'displayed'
           when outbox.status = 'quarantined' then 'quarantined'
           when outbox.status = 'retryable_failure' then 'failed'
           when outbox.status = 'pending' then 'accepted'
           else coalesce(outbox.status, 'accepted')
         end,
         event.created_at,
         payment.gross_amount_paise,
         payment.currency,
         nullif(event.payload ->> 'displayName', ''),
         nullif(event.payload ->> 'message', '')
    from public.alert_events event
    left join public.event_outbox outbox on outbox.event_id = event.id
    left join public.payments payment on payment.id = event.payment_id
   where event.channel_id = target_channel_id
     and app_private.can_access_channel(target_channel_id)
     and (target_cursor is null or event.created_at < target_cursor)
   order by event.created_at desc
   limit greatest(1, least(target_limit, 100))
$$;

create or replace function app_private.get_companion_state(target_channel_id uuid)
returns table (
  overlay_connected boolean,
  pending_alerts integer,
  last_updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select exists (
           select 1 from public.overlay_sessions session
            where session.channel_id = target_channel_id
              and session.revoked_at is null
              and session.expires_at > current_timestamp
         ),
         (select count(*)::integer from public.event_outbox outbox
           join public.alert_events event on event.id = outbox.event_id
          where event.channel_id = target_channel_id
            and outbox.status in ('pending', 'enqueued', 'retryable_failure')),
         current_timestamp
   where app_private.can_access_channel(target_channel_id)
$$;

create or replace function app_private.lookup_overlay_token(
  target_overlay_id uuid,
  target_token_fingerprint text
)
returns table (overlay_id uuid, channel_id uuid, expires_at timestamptz)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select session.id, session.channel_id, session.expires_at
    from public.overlay_sessions session
   where session.id = target_overlay_id
     and session.token_fingerprint = target_token_fingerprint
     and session.revoked_at is null
     and session.expires_at > current_timestamp
   limit 1
$$;

create or replace function app_private.get_overlay_events(
  target_overlay_id uuid,
  target_after_created_at timestamptz,
  target_after_delivery_id uuid,
  target_limit integer
)
returns table (
  cursor text,
  event_id uuid,
  event_type text,
  trace_id text,
  created_at timestamptz,
  payload jsonb
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select to_char(delivery.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || delivery.id::text,
         event.id,
         case
           when delivery.status = 'held' then 'alert.hold'
           when delivery.status in ('displayed', 'acknowledged') then 'alert.complete'
           else 'alert.ready'
         end,
         event.trace_id,
         delivery.created_at,
         event.payload
    from public.event_outbox_deliveries delivery
    join public.event_outbox outbox on outbox.id = delivery.outbox_id
    join public.alert_events event on event.id = delivery.event_id
    join public.overlay_sessions session on session.id = target_overlay_id
   where target_overlay_id = app_private.current_overlay_session_id()
     and session.id = target_overlay_id
       and session.revoked_at is null
       and session.expires_at > current_timestamp
       and delivery.status in ('ready', 'held', 'displayed', 'acknowledged')
     and (
       target_after_created_at is null
       or delivery.created_at > target_after_created_at
       or (delivery.created_at = target_after_created_at and delivery.id > coalesce(target_after_delivery_id, '00000000-0000-0000-0000-000000000000'::uuid))
     )
   order by delivery.created_at asc, delivery.id asc
   limit greatest(1, least(target_limit, 100))
$$;

create or replace function app_private.ack_overlay_cursor(
  target_overlay_id uuid,
  target_cursor text,
  target_event_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if target_overlay_id <> app_private.current_overlay_session_id() then
    return false;
  end if;
  if not exists (
    select 1 from public.overlay_sessions session
     where session.id = target_overlay_id
       and session.revoked_at is null
       and session.expires_at > current_timestamp
  ) then
    return false;
  end if;

  -- A valid overlay token is not enough to acknowledge arbitrary state. The
  -- cursor and event must be an actual durable delivery for this overlay's
  -- channel, and the cursor must be the exact server-issued delivery cursor.
  if not exists (
    select 1
      from public.overlay_sessions session
      join public.event_outbox_deliveries delivery on true
      join public.event_outbox outbox on outbox.id = delivery.outbox_id
      join public.alert_events event on event.id = delivery.event_id
     where session.id = target_overlay_id
       and event.channel_id = session.channel_id
       and event.id = target_event_id
       and delivery.status in ('ready', 'held', 'displayed', 'acknowledged')
       and to_char(delivery.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || delivery.id::text = target_cursor
  ) then
    return false;
  end if;

  insert into public.overlay_cursors (overlay_session_id, cursor, last_event_id, acknowledged_at, updated_at)
  values (target_overlay_id, target_cursor, target_event_id, current_timestamp, current_timestamp)
  on conflict (overlay_session_id, cursor) do update
    set last_event_id = excluded.last_event_id,
        acknowledged_at = excluded.acknowledged_at,
        updated_at = excluded.updated_at;
  return true;
end
$$;

create or replace function app_private.resolve_queue_bindings(
  target_channel_id uuid,
  target_source_type text,
  target_source_id text
)
returns table (
  binding_id uuid,
  queue_id uuid,
  allow_duplicates boolean,
  priority integer,
  override_values jsonb
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select binding.id, binding.queue_id, binding.allow_duplicates, binding.priority, binding.override_values
    from public.queue_bindings binding
   where binding.channel_id = target_channel_id
     and binding.closed_at is null
     and binding.source_type = target_source_type
     and binding.source_id in (target_source_id, '__channel_default__')
     and not (
       binding.source_id = '__channel_default__'
       and exists (
         select 1
           from public.queue_bindings exact_binding
          where exact_binding.channel_id = target_channel_id
            and exact_binding.closed_at is null
            and exact_binding.source_type = target_source_type
            and exact_binding.source_id = target_source_id
       )
     )
   order by binding.priority desc, binding.created_at asc, binding.id asc
$$;

alter table user_sessions enable row level security;
alter table channel_configs enable row level security;
alter table queue_bindings enable row level security;
alter table alert_moderation_actions enable row level security;
alter table companion_commands enable row level security;

create policy sessions_self_select
  on user_sessions for select to bsa_app
  using (user_id = app_private.current_user_id());

create policy sessions_self_update
  on user_sessions for update to bsa_app
  using (user_id = app_private.current_user_id())
  with check (user_id = app_private.current_user_id());

create policy configs_member_select
  on channel_configs for select to bsa_app
  using (app_private.can_access_channel(channel_id));

create policy configs_admin_insert
  on channel_configs for insert to bsa_app
  with check (app_private.has_channel_role(channel_id, array['owner', 'admin']::text[]));

create policy bindings_member_select
  on queue_bindings for select to bsa_app
  using (app_private.can_access_channel(channel_id));

create policy bindings_operator_write
  on queue_bindings for all to bsa_app
  using (app_private.has_channel_role(channel_id, array['owner', 'admin', 'operator']::text[]))
  with check (app_private.has_channel_role(channel_id, array['owner', 'admin', 'operator']::text[]));

create policy moderation_member_select
  on alert_moderation_actions for select to bsa_app
  using (app_private.can_access_channel(channel_id));

create policy moderation_operator_insert
  on alert_moderation_actions for insert to bsa_app
  with check (
    actor_user_id = app_private.current_user_id()
    and app_private.has_channel_role(channel_id, array['owner', 'admin', 'operator', 'moderator']::text[])
  );

create policy companion_member_select
  on companion_commands for select to bsa_app
  using (app_private.can_access_channel(channel_id));

create policy companion_operator_insert
  on companion_commands for insert to bsa_app
  with check (
    actor_user_id = app_private.current_user_id()
    and app_private.has_channel_role(channel_id, array['owner', 'admin', 'operator', 'moderator']::text[])
  );

revoke execute on function app_private.create_user_session(uuid, text, text, text, text, timestamptz, uuid) from public;
revoke execute on function app_private.lookup_session(text) from public;
grant execute on function app_private.create_user_session(uuid, text, text, text, text, timestamptz, uuid) to bsa_app;
grant execute on function app_private.lookup_session(text) to bsa_app;
revoke execute on function app_private.create_channel(uuid, uuid, text, text) from public;
revoke execute on function app_private.create_manual_alert(uuid, uuid, uuid, uuid, text, bigint, jsonb) from public;
grant execute on function app_private.create_channel(uuid, uuid, text, text) to bsa_app;
grant execute on function app_private.create_manual_alert(uuid, uuid, uuid, uuid, text, bigint, jsonb) to bsa_app;
revoke execute on function app_private.get_alert_history(uuid, timestamptz, integer) from public;
revoke execute on function app_private.get_companion_state(uuid) from public;
grant execute on function app_private.get_alert_history(uuid, timestamptz, integer) to bsa_app;
grant execute on function app_private.get_companion_state(uuid) to bsa_app;
revoke execute on function app_private.lookup_overlay_token(uuid, text) from public;
revoke execute on function app_private.get_overlay_events(uuid, timestamptz, uuid, integer) from public;
grant execute on function app_private.lookup_overlay_token(uuid, text) to bsa_app;
grant execute on function app_private.get_overlay_events(uuid, timestamptz, uuid, integer) to bsa_app;
revoke execute on function app_private.ack_overlay_cursor(uuid, text, uuid) from public;
grant execute on function app_private.ack_overlay_cursor(uuid, text, uuid) to bsa_app;
revoke execute on function app_private.resolve_queue_bindings(uuid, text, text) from public;
grant execute on function app_private.resolve_queue_bindings(uuid, text, text) to bsa_alert_worker;
grant usage on schema app_private to bsa_alert_worker;

grant usage on schema public, app_private to bsa_app;
grant select on public.app_users, public.channels, public.channel_memberships,
  public.channel_entitlement_versions, public.alert_queues, public.queue_bindings,
  public.payments, public.refunds, public.alert_events, public.user_sessions,
  public.channel_configs, public.alert_moderation_actions, public.companion_commands,
  public.overlay_sessions to bsa_app;
grant insert, update on public.channels, public.channel_configs, public.alert_queues,
  public.queue_bindings, public.user_sessions, public.overlay_sessions to bsa_app;
grant insert on public.alert_moderation_actions, public.companion_commands to bsa_app;

-- No public/client role receives direct table access. Deployment grants only
-- the exact table/function privileges required by the API handlers.
