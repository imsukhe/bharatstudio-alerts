-- L03 binding lifecycle hardening.
-- New routing bindings may target only an open queue. Existing bindings are
-- retained when a queue is paused/closed so accepted delivery snapshots and
-- audit history remain intact; reopening the queue restores future routing.

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
         and queue.closed_at is null
    )
  );
