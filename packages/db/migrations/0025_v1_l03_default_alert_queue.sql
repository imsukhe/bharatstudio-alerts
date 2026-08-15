-- BharatStudio Alerts v1 default queue safety boundary.
-- A channel must have an alert destination before its public tip page can
-- safely accept a payment. This migration backfills one deterministic queue
-- for active channels with no open queue and makes future channel creation
-- create the same queue atomically with the channel/config/entitlement rows.

insert into public.alert_queues (id, channel_id, name, created_at, updated_at)
select md5('default-alert-queue:' || channel.id::text)::uuid,
       channel.id,
       'Main alerts',
       current_timestamp,
       current_timestamp
  from public.channels channel
 where channel.closed_at is null
   and not exists (
     select 1
       from public.alert_queues queue
      where queue.channel_id = channel.id
        and queue.closed_at is null
   )
on conflict (id) do nothing;

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
  ), inserted_queue as (
    insert into public.alert_queues (id, channel_id, name, created_at, updated_at)
    select md5('default-alert-queue:' || inserted_channel.id::text)::uuid,
           inserted_channel.id,
           'Main alerts',
           current_timestamp,
           current_timestamp
      from inserted_channel
    returning channel_id
  ), inserted_payment_binding as (
    insert into public.queue_bindings (
      id, channel_id, queue_id, source_type, source_id, allow_duplicates,
      priority, created_at
    )
    select md5('default-payment-binding:' || inserted_channel.id::text)::uuid,
           inserted_channel.id,
           md5('default-alert-queue:' || inserted_channel.id::text)::uuid,
           'payment',
           '__channel_default__',
           false,
           0,
           current_timestamp
      from inserted_channel
    returning channel_id
  )
  select channel_id from inserted_membership
$$;

revoke execute on function app_private.create_channel(uuid, uuid, text, text) from public;
grant execute on function app_private.create_channel(uuid, uuid, text, text) to bsa_app;
