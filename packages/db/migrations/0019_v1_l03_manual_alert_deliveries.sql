-- BharatStudio Alerts v1 manual/test-alert delivery projection.
-- An accepted manual alert must create durable per-queue delivery rows in the
-- same transaction as its event/outbox record. The API supplies queueIds after
-- resolving active queues; callers cannot inject a queue from another channel.

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
declare
  selected_queue record;
  requested_ids jsonb := target_payload -> 'queueIds';
  delivery_count integer := 0;
begin
  if target_user_id <> app_private.current_user_id() then
    raise exception 'actor mismatch' using errcode = '42501';
  end if;
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin', 'operator', 'moderator']::text[]) then
    raise exception 'channel access denied' using errcode = '42501';
  end if;
  if not (target_payload ? 'queueIds') or jsonb_typeof(requested_ids) <> 'array' or jsonb_array_length(requested_ids) = 0 then
    raise exception 'manual alert requires at least one queue' using errcode = '22023';
  end if;
  if exists (
    select 1
      from jsonb_array_elements_text(requested_ids) selected(value)
     where not exists (
       select 1 from public.alert_queues queue
        where queue.id::text = selected.value
          and queue.channel_id = target_channel_id
          and queue.closed_at is null
     )
  ) then
    raise exception 'manual alert queue selection is invalid' using errcode = '42501';
  end if;

  insert into public.alert_events (id, channel_id, payment_id, source_type, source_id, trace_id, config_snapshot_version, payload, created_at)
  values (target_event_id, target_channel_id, null, 'manual', target_event_id::text, target_trace_id, target_config_snapshot_version, target_payload, current_timestamp);

  insert into public.event_outbox (id, event_id, status, available_at, created_at, updated_at)
  values (target_outbox_id, target_event_id, 'pending', current_timestamp, current_timestamp, current_timestamp);

  for selected_queue in
    select queue.id as queue_id,
           coalesce(binding.id, md5('manual-binding:' || target_event_id::text || ':' || queue.id::text)::uuid) as binding_id,
           coalesce(binding.priority, 0) as source_priority,
           coalesce(binding.override_values, '{}'::jsonb) as override_values
      from public.alert_queues queue
      left join lateral (
        select candidate.id, candidate.priority, candidate.override_values
          from public.queue_bindings candidate
         where candidate.channel_id = target_channel_id
           and candidate.queue_id = queue.id
           and candidate.closed_at is null
           and candidate.source_type = 'manual'
           and candidate.source_id = target_event_id::text
         order by candidate.priority desc, candidate.created_at asc, candidate.id asc
         limit 1
      ) binding on true
     where queue.channel_id = target_channel_id
       and queue.closed_at is null
       and queue.id::text in (select distinct value from jsonb_array_elements_text(requested_ids))
     order by source_priority desc, queue.created_at asc, queue.id asc
  loop
    delivery_count := delivery_count + 1;
    insert into public.event_outbox_deliveries (
      id, event_id, outbox_id, queue_id, binding_id, source_id,
      config_snapshot_version, delivery_sequence, source_priority, override_values,
      status, attempt_count, created_at, updated_at
    )
    values (
      md5('manual-delivery:' || target_event_id::text || ':' || selected_queue.queue_id::text)::uuid,
      target_event_id, target_outbox_id, selected_queue.queue_id, selected_queue.binding_id, target_event_id::text,
      target_config_snapshot_version, delivery_count, selected_queue.source_priority, selected_queue.override_values,
      'ready', 0, current_timestamp, current_timestamp
    );
  end loop;

  if delivery_count = 0 then
    raise exception 'manual alert has no active queues' using errcode = '22023';
  end if;
  return query select target_event_id, target_trace_id;
end
$$;

revoke execute on function app_private.create_manual_alert(uuid, uuid, uuid, uuid, text, bigint, jsonb) from public;
grant execute on function app_private.create_manual_alert(uuid, uuid, uuid, uuid, text, bigint, jsonb) to bsa_app;
