-- L03/L04 queue lifecycle guard.
--
-- A closed queue remains part of history, but it must never receive a new
-- delivery. The application normally filters closed queues while resolving
-- payment bindings; this trigger is the transaction-level backstop for the
-- race where a queue is closed after resolution but before persistence.

-- The delivery table does not carry channel_id, so derive it from the event
-- in a small trigger wrapper. Keeping the check in the database makes both
-- payment persistence and any future producer obey the same invariant.
create or replace function app_private.require_open_delivery_queue()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  event_channel_id uuid;
begin
  select event.channel_id
    into event_channel_id
    from public.alert_events event
   where event.id = new.event_id;

  if event_channel_id is null or not exists (
    select 1
      from public.alert_queues queue
     where queue.id = new.queue_id
       and queue.channel_id = event_channel_id
       and queue.closed_at is null
  ) then
    raise exception 'delivery queue is closed or not in the event channel'
      using errcode = '23514';
  end if;
  return new;
end
$$;

drop trigger if exists event_outbox_delivery_open_queue_guard on public.event_outbox_deliveries;
create trigger event_outbox_delivery_open_queue_guard
before insert on public.event_outbox_deliveries
for each row execute function app_private.require_open_delivery_queue();

revoke execute on function app_private.require_open_delivery_queue() from public;

-- A channel may not close its final open queue. The channel can first stop
-- accepting tips, but preserving one queue keeps in-flight and future
-- recovery paths from becoming destination-less.
create or replace function app_private.prevent_last_queue_close()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if old.closed_at is null and new.closed_at is not null and not exists (
    select 1
      from public.alert_queues queue
     where queue.channel_id = old.channel_id
       and queue.id <> old.id
       and queue.closed_at is null
  ) then
    raise exception 'channel must retain one open alert queue'
      using errcode = '23514';
  end if;
  return new;
end
$$;

drop trigger if exists alert_queue_last_open_guard on public.alert_queues;
create trigger alert_queue_last_open_guard
before update of closed_at on public.alert_queues
for each row execute function app_private.prevent_last_queue_close();

revoke execute on function app_private.prevent_last_queue_close() from public;
