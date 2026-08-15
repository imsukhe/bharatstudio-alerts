-- L05 publication/acknowledgement boundary.
--
-- A worker task publishes an already-durable delivery to the overlay stream;
-- it must not mark the delivery terminal before the browser has displayed and
-- acknowledged it. Release clears the worker lease and leaves the delivery
-- ready for durable replay. The overlay acknowledgement then moves it to
-- acknowledged and refreshes the outbox read model.

create or replace function app_private.release_event_delivery(
  target_delivery_id uuid,
  target_lease_token uuid
)
returns table (delivery_id uuid, state_version bigint, status text)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  local_outbox_id uuid;
begin
  update public.event_outbox_deliveries delivery
     set status = 'ready',
         next_action_at = null,
         last_error_code = null,
         state_version = delivery.state_version + 1,
         lease_token = null,
         lease_until = null,
         updated_at = current_timestamp
   where delivery.id = target_delivery_id
     and delivery.lease_token = target_lease_token
     and delivery.lease_until > current_timestamp
     and delivery.status = 'ready'
  returning delivery.id, delivery.outbox_id, delivery.state_version, delivery.status
    into delivery_id, local_outbox_id, state_version, status;

  if not found then
    return;
  end if;

  perform app_private.refresh_event_outbox_status(local_outbox_id);
  return next;
end
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
declare
  local_delivery_id uuid;
  local_outbox_id uuid;
  local_status text;
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

  select delivery.id, delivery.outbox_id, delivery.status
    into local_delivery_id, local_outbox_id, local_status
    from public.overlay_sessions session
    join public.event_outbox_deliveries delivery on true
    join public.alert_events event on event.id = delivery.event_id
   where session.id = target_overlay_id
     and event.channel_id = session.channel_id
     and event.id = target_event_id
     and delivery.status in ('ready', 'held', 'displayed', 'acknowledged')
     and to_char(delivery.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || delivery.id::text = target_cursor;

  if local_delivery_id is null then
    return false;
  end if;

  insert into public.overlay_cursors (overlay_session_id, cursor, last_event_id, acknowledged_at, updated_at)
  values (target_overlay_id, target_cursor, target_event_id, current_timestamp, current_timestamp)
  on conflict (overlay_session_id, cursor) do update
    set last_event_id = excluded.last_event_id,
        acknowledged_at = excluded.acknowledged_at,
        updated_at = excluded.updated_at;

  if local_status <> 'acknowledged' then
    update public.event_outbox_deliveries
       set status = 'acknowledged',
           state_version = state_version + 1,
           lease_token = null,
           lease_until = null,
           updated_at = current_timestamp
     where id = local_delivery_id
       and status in ('ready', 'held', 'displayed');
  end if;
  -- Refresh even on an idempotent acknowledgement so a previously stale
  -- outbox read-model cannot survive a successful cursor replay.
  perform app_private.refresh_event_outbox_status(local_outbox_id);
  return true;
end
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
           else 'alert.ready'
         end,
         event.trace_id,
         delivery.created_at,
         event.payload || jsonb_build_object(
           'deliveryId', delivery.id,
           'queueId', delivery.queue_id,
           'bindingId', delivery.binding_id,
           'configSnapshotVersion', delivery.config_snapshot_version,
           'deliverySequence', delivery.delivery_sequence,
           'sourcePriority', delivery.source_priority,
           'overrideValues', coalesce(delivery.override_values, '{}'::jsonb)
         )
    from public.event_outbox_deliveries delivery
    join public.event_outbox outbox on outbox.id = delivery.outbox_id
    join public.alert_events event on event.id = delivery.event_id
    join public.overlay_sessions session on session.id = target_overlay_id
   where target_overlay_id = app_private.current_overlay_session_id()
     and session.id = target_overlay_id
     and session.revoked_at is null
     and session.expires_at > current_timestamp
     and delivery.status in ('ready', 'held', 'displayed')
     and (
       target_after_created_at is null
       or delivery.created_at > target_after_created_at
       or (delivery.created_at = target_after_created_at and delivery.id > coalesce(target_after_delivery_id, '00000000-0000-0000-0000-000000000000'::uuid))
     )
   order by delivery.created_at asc, delivery.id asc
   limit greatest(1, least(target_limit, 100))
$$;

revoke execute on function app_private.release_event_delivery(uuid, uuid) from public;
grant execute on function app_private.release_event_delivery(uuid, uuid) to bsa_alert_worker;
revoke execute on function app_private.ack_overlay_cursor(uuid, text, uuid) from public;
grant execute on function app_private.ack_overlay_cursor(uuid, text, uuid) to bsa_app;
revoke execute on function app_private.get_overlay_events(uuid, timestamptz, uuid, integer) from public;
grant execute on function app_private.get_overlay_events(uuid, timestamptz, uuid, integer) to bsa_app;
