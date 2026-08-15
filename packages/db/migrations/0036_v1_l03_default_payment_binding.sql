-- BharatStudio Alerts v1 default payment source routing.
-- A creator configures queues before a provider payment ID exists. The
-- reserved channel-default binding is the fallback; an exact payment source
-- binding always takes precedence. This migration is additive and does not
-- rewrite accepted payments or delivery snapshots.

insert into public.queue_bindings (
  id, channel_id, queue_id, source_type, source_id, allow_duplicates,
  priority, created_at
)
select md5('default-payment-binding:' || queue.id::text)::uuid,
       queue.channel_id,
       queue.id,
       'payment',
       '__channel_default__',
       false,
       0,
       current_timestamp
  from public.alert_queues queue
 where queue.closed_at is null
   and not exists (
     select 1
       from public.queue_bindings binding
      where binding.queue_id = queue.id
        and binding.source_type = 'payment'
        and binding.source_id = '__channel_default__'
        and binding.closed_at is null
   )
on conflict (queue_id, source_type, source_id) do nothing;

create or replace function app_private.ensure_default_payment_binding()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  insert into public.queue_bindings (
    id, channel_id, queue_id, source_type, source_id, allow_duplicates,
    priority, created_at
  )
  values (
    md5('default-payment-binding:' || new.id::text)::uuid,
    new.channel_id,
    new.id,
    'payment',
    '__channel_default__',
    false,
    0,
    current_timestamp
  )
  on conflict (queue_id, source_type, source_id) do nothing;
  return new;
end
$$;

drop trigger if exists alert_queue_default_payment_binding on public.alert_queues;
create trigger alert_queue_default_payment_binding
  after insert on public.alert_queues
  for each row execute function app_private.ensure_default_payment_binding();

revoke execute on function app_private.ensure_default_payment_binding() from public;

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
  select binding.id, binding.queue_id, binding.allow_duplicates,
         binding.priority, binding.override_values
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

revoke execute on function app_private.resolve_queue_bindings(uuid, text, text) from public;
grant execute on function app_private.resolve_queue_bindings(uuid, text, text) to bsa_alert_worker;
