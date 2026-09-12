-- L03 entitlement retier + the eight locked dimensions (MASTER-PLAN §3.2).
--
-- Two things happen here:
--   1. app_private.tier_queue_count() retiers down: pro 3->2, creator 5->3,
--      studio 10->5 (free stays 1). Same function shape, same 22023
--      exception for an unrecognised tier as 0070 established.
--   2. All eight entitlement dimensions from §3.2 (queueCount plus the
--      other seven, which were "wired, values unset" per the plan) are now
--      computed by one function, app_private.tier_entitlement_dimensions(),
--      and merged into channel_entitlement_versions.values by the same
--      publish paths 0070 already uses (create_channel,
--      publish_active_individual_entitlement, publish_free_entitlement) —
--      no new publish mechanism is invented.
--
-- DOWNGRADE-STRANDING APPROACH (retiering down can leave a channel over its
-- new queueCount limit without any new webhook event to trigger
-- enforcement):
--   0070's app_private.enforce_queue_count_entitlement() already pauses a
--   channel's newest-excess queues, oldest-first retention, and is
--   idempotent/non-destructive (never deletes, never re-pauses a queue a
--   creator paused manually, never relabels an existing pause). Redefining
--   tier_queue_count() alone does not re-run that function for a channel
--   that already has a published entitlement and no new subscription event
--   — it would sit stranded until its next billing event. So this migration
--   explicitly re-runs enforce_queue_count_entitlement() for every existing
--   channel, against its currently-published tier, once, right after the
--   retier. This is a data-safe backfill (pause-only) using the exact
--   existing mechanism, not a new one. Every channel's latest entitlement
--   version's `values` is then refreshed in place (not a new version row)
--   with the newly computed eight dimensions, so a dashboard/API read of
--   the latest row reflects the retiered limits immediately instead of
--   waiting for the next publish event. Older version rows are untouched —
--   history is preserved.

create or replace function app_private.tier_queue_count(target_tier text)
returns integer
language plpgsql
immutable
as $$
begin
  case target_tier
    when 'free' then return 1;
    when 'pro' then return 2;
    when 'creator' then return 3;
    when 'studio' then return 5;
    else raise exception 'unknown entitlement tier: %', target_tier using errcode = '22023';
  end case;
end
$$;

-- Single source of truth for the eight locked dimensions (MASTER-PLAN §3.2),
-- per tier. 0081 (applied next) create-or-replaces this same function to
-- merge in `ttsMonthlyCharQuota` alongside `ttsEnabled` per the plan's note
-- in §3.2 — that key is not one of the eight, same "hidden extra value"
-- treatment §3.2/Part 13 decision 8 already gives `lottieEnabled` — once
-- app_private.tier_tts_monthly_quota() exists to be its one source of
-- truth. It is intentionally left out of this migration's definition since
-- that function does not exist yet at this point in migration order.
create or replace function app_private.tier_entitlement_dimensions(target_tier text)
returns jsonb
language plpgsql
immutable
as $$
begin
  case target_tier
    when 'free' then
      return jsonb_build_object(
        'queueCount', 1,
        'ttsEnabled', false,
        'allowedQueueModes', jsonb_build_array('fifo'),
        'maxVisibleItems', 3,
        'maxCharLimit', 100,
        'maxDisplayMs', 6000,
        'quietMode', false,
        'approvalRequired', false
      );
    when 'pro' then
      return jsonb_build_object(
        'queueCount', 2,
        'ttsEnabled', true,
        'allowedQueueModes', jsonb_build_array('fifo', 'stacked', 'aggregated'),
        'maxVisibleItems', 5,
        'maxCharLimit', 150,
        'maxDisplayMs', 8000,
        'quietMode', true,
        'approvalRequired', false
      );
    when 'creator' then
      return jsonb_build_object(
        'queueCount', 3,
        'ttsEnabled', true,
        'allowedQueueModes', jsonb_build_array('fifo', 'stacked', 'aggregated', 'priority'),
        'maxVisibleItems', 8,
        'maxCharLimit', 300,
        'maxDisplayMs', 12000,
        'quietMode', true,
        'approvalRequired', true
      );
    when 'studio' then
      return jsonb_build_object(
        'queueCount', 5,
        'ttsEnabled', true,
        'allowedQueueModes', jsonb_build_array('fifo', 'stacked', 'aggregated', 'priority', 'approval'),
        'maxVisibleItems', 12,
        'maxCharLimit', 500,
        'maxDisplayMs', 20000,
        'quietMode', true,
        'approvalRequired', true
      );
    else raise exception 'unknown entitlement tier: %', target_tier using errcode = '22023';
  end case;
end
$$;

-- Re-created only to merge the full eight-dimension jsonb instead of just
-- queueCount. Everything else (idempotency check, enforcement call) is
-- unchanged from 0070's definition.
create or replace function app_private.publish_free_entitlement(
  target_channel_id uuid,
  target_effective_at timestamptz
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  latest public.channel_entitlement_versions%rowtype;
  next_version bigint;
begin
  perform 1 from public.channels where id = target_channel_id for update;
  if not found then
    raise exception 'channel not found for free entitlement projection' using errcode = '23503';
  end if;

  select entitlement.* into latest
    from public.channel_entitlement_versions entitlement
   where entitlement.channel_id = target_channel_id
   order by entitlement.version desc
   limit 1;

  if found and latest.tier = 'free' then
    return;
  end if;

  select coalesce(max(entitlement.version), 0) + 1
    into next_version
    from public.channel_entitlement_versions entitlement
   where entitlement.channel_id = target_channel_id;

  insert into public.channel_entitlement_versions (
    channel_id, version, tier, source, values, effective_at, created_at
  ) values (
    target_channel_id, next_version, 'free', 'individual_plan',
    app_private.tier_entitlement_dimensions('free'),
    coalesce(target_effective_at, current_timestamp), current_timestamp
  );

  perform app_private.enforce_queue_count_entitlement(target_channel_id, 'free');
end
$$;

create or replace function app_private.publish_active_individual_entitlement(
  target_channel_id uuid,
  target_tier text,
  target_subscription_id text,
  target_billing_interval text,
  target_price_paise bigint,
  target_effective_at timestamptz
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  latest public.channel_entitlement_versions%rowtype;
  next_version bigint;
begin
  if target_tier not in ('pro', 'creator', 'studio')
     or target_billing_interval not in ('monthly', 'annual')
     or target_subscription_id is null
     or target_subscription_id = ''
     or target_effective_at is null then
    raise exception 'invalid active entitlement projection' using errcode = '22023';
  end if;

  perform 1
    from public.channels
   where id = target_channel_id
   for update;
  if not found then
    raise exception 'channel not found for active entitlement projection' using errcode = '23503';
  end if;

  select entitlement.* into latest
    from public.channel_entitlement_versions entitlement
   where entitlement.channel_id = target_channel_id
   order by entitlement.version desc
   limit 1;

  if found
     and latest.tier = target_tier
     and latest.values ->> 'subscriptionId' = target_subscription_id then
    return;
  end if;

  select coalesce(max(entitlement.version), 0) + 1
    into next_version
    from public.channel_entitlement_versions entitlement
   where entitlement.channel_id = target_channel_id;

  insert into public.channel_entitlement_versions (
    channel_id, version, tier, source, values, effective_at, created_at
  ) values (
    target_channel_id, next_version, target_tier, 'individual_plan',
    app_private.tier_entitlement_dimensions(target_tier) || jsonb_build_object(
      'subscriptionId', target_subscription_id,
      'billingInterval', target_billing_interval,
      'monthlyPricePaise', target_price_paise
    ),
    target_effective_at, current_timestamp
  );

  perform app_private.enforce_queue_count_entitlement(target_channel_id, target_tier);
end
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
    select inserted_channel.id, 1, 'free', 'individual_plan',
           app_private.tier_entitlement_dimensions('free'),
           current_timestamp, current_timestamp
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

-- Backfill: bring every existing channel's already-published latest
-- entitlement version in line with the retiered limits and the newly
-- materialized eight-dimension values, right now, rather than waiting for
-- its next subscription webhook event. Pause-only (never deletes a queue,
-- never touches an already-paused queue's reason/timestamp — see 0070).
do $$
declare
  channel_row record;
begin
  for channel_row in
    select distinct on (entitlement.channel_id)
           entitlement.channel_id, entitlement.tier, entitlement.version
      from public.channel_entitlement_versions entitlement
     order by entitlement.channel_id, entitlement.version desc
  loop
    perform app_private.enforce_queue_count_entitlement(channel_row.channel_id, channel_row.tier);

    update public.channel_entitlement_versions
       set values = values || app_private.tier_entitlement_dimensions(channel_row.tier)
     where channel_id = channel_row.channel_id
       and version = channel_row.version;
  end loop;
end
$$;

revoke execute on function app_private.tier_queue_count(text) from public;
revoke execute on function app_private.tier_entitlement_dimensions(text) from public;
grant execute on function app_private.tier_queue_count(text) to bsa_app, bsa_payment;
grant execute on function app_private.tier_entitlement_dimensions(text) to bsa_app, bsa_payment;
