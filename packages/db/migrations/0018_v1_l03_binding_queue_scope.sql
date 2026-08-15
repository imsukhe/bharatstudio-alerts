-- BharatStudio Alerts v1 queue-binding channel integrity.
-- A binding's queue must belong to the same channel as the binding row.

drop policy if exists bindings_operator_write on public.queue_bindings;

create policy bindings_operator_write
  on public.queue_bindings for all to bsa_app
  using (app_private.has_channel_role(channel_id, array['owner', 'admin', 'operator']::text[]))
  with check (
    app_private.has_channel_role(channel_id, array['owner', 'admin', 'operator']::text[])
    and exists (
      select 1
        from public.alert_queues queue
       where queue.id = queue_bindings.queue_id
         and queue.channel_id = queue_bindings.channel_id
    )
  );
