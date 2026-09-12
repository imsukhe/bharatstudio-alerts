-- L03 acceptance: 0080's retier + eight-dimension publish, and its
-- over-limit-channel backfill. Never deletes a resource, only pauses. Fails
-- closed on an unrecognised tier. Synthetic identifiers only.

\set ON_ERROR_STOP on

do $$
begin
  if app_private.tier_queue_count('free') <> 1
     or app_private.tier_queue_count('pro') <> 2
     or app_private.tier_queue_count('creator') <> 3
     or app_private.tier_queue_count('studio') <> 5 then
    raise exception 'tier_queue_count does not match the 3.2 retiered values';
  end if;
  begin
    perform app_private.tier_queue_count('enterprise');
    raise exception 'tier_queue_count accepted an unapproved tier';
  exception when sqlstate '22023' then
    null;
  end;
  begin
    perform app_private.tier_entitlement_dimensions('enterprise');
    raise exception 'tier_entitlement_dimensions accepted an unapproved tier';
  exception when sqlstate '22023' then
    null;
  end;
end
$$;

-- Existing (pre-retier) channel: on creator tier with 5 active queues,
-- created before this migration ran, simulating a real channel that was
-- fine under the old creator limit (5) and is now over the new one (3).
insert into app_users (id, external_subject, display_name, created_at, updated_at)
values ('00000000-0000-4000-8000-000000001101', 'google-l03-retier', 'Synthetic Retier Owner', current_timestamp, current_timestamp);

begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000001101', true);
select * from app_private.create_channel(
  '00000000-0000-4000-8000-000000001121',
  '00000000-0000-4000-8000-000000001101', 'retier_backfill_test', 'Retier Backfill Test'
);
commit;

-- Force the channel onto 'creator' at the OLD limit (5), as if it had
-- subscribed before this migration existed, then add queues up to the old
-- limit, oldest-first, mirroring a channel actually using its old headroom.
update channel_entitlement_versions
   set tier = 'creator', values = '{"queueCount": 5}'::jsonb
 where channel_id = '00000000-0000-4000-8000-000000001121';

insert into alert_queues (id, channel_id, name, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000001111', '00000000-0000-4000-8000-000000001121', 'Second queue', current_timestamp + interval '1 minute', current_timestamp + interval '1 minute'),
  ('00000000-0000-4000-8000-000000001112', '00000000-0000-4000-8000-000000001121', 'Third queue', current_timestamp + interval '2 minutes', current_timestamp + interval '2 minutes'),
  ('00000000-0000-4000-8000-000000001113', '00000000-0000-4000-8000-000000001121', 'Fourth queue', current_timestamp + interval '3 minutes', current_timestamp + interval '3 minutes'),
  ('00000000-0000-4000-8000-000000001114', '00000000-0000-4000-8000-000000001121', 'Fifth queue', current_timestamp + interval '4 minutes', current_timestamp + interval '4 minutes');

-- Re-run the exact backfill 0080 performs (idempotent — proves the
-- migration's own effect deterministically, in case migration order in
-- this harness re-applies 0080 before these queues existed).
do $$
declare
  channel_row record;
begin
  for channel_row in
    select distinct on (entitlement.channel_id)
           entitlement.channel_id, entitlement.tier, entitlement.version
      from channel_entitlement_versions entitlement
     where entitlement.channel_id = '00000000-0000-4000-8000-000000001121'
     order by entitlement.channel_id, entitlement.version desc
  loop
    perform app_private.enforce_queue_count_entitlement(channel_row.channel_id, channel_row.tier);
    update channel_entitlement_versions
       set values = values || app_private.tier_entitlement_dimensions(channel_row.tier)
     where channel_id = channel_row.channel_id
       and version = channel_row.version;
  end loop;
end
$$;

do $$
declare
  open_active_count integer;
  paused_count integer;
  published_values jsonb;
begin
  select count(*) into open_active_count
    from alert_queues
   where channel_id = '00000000-0000-4000-8000-000000001121'
     and closed_at is null and is_paused = false;
  if open_active_count <> 3 then
    raise exception 'over-limit channel was not enforced down to the new creator limit of 3: % active queues remain', open_active_count;
  end if;

  select count(*) into paused_count
    from alert_queues
   where channel_id = '00000000-0000-4000-8000-000000001121'
     and is_paused = true and paused_reason = 'tier_downgrade';
  if paused_count <> 2 then
    raise exception 'expected exactly 2 queues paused by the retier backfill, got %', paused_count;
  end if;

  if exists (select 1 from alert_queues where channel_id = '00000000-0000-4000-8000-000000001121' and closed_at is not null) then
    raise exception 'backfill deleted/closed a queue instead of only pausing it';
  end if;

  select values into published_values
    from channel_entitlement_versions
   where channel_id = '00000000-0000-4000-8000-000000001121'
   order by version desc limit 1;
  if (published_values ->> 'queueCount')::int <> 3
     or (published_values ->> 'ttsEnabled')::boolean is distinct from true
     or (published_values ->> 'maxVisibleItems')::int <> 8
     or (published_values ->> 'maxCharLimit')::int <> 300
     or (published_values ->> 'maxDisplayMs')::int <> 12000
     or (published_values ->> 'quietMode')::boolean is distinct from true
     or (published_values ->> 'approvalRequired')::boolean is distinct from true
     or (published_values -> 'allowedQueueModes') is null then
    raise exception 'latest entitlement row was not refreshed with the full eight-dimension creator values: %', published_values;
  end if;
end
$$;

-- A brand-new free channel gets all eight dimensions on creation, not just
-- queueCount.
insert into app_users (id, external_subject, display_name, created_at, updated_at)
values ('00000000-0000-4000-8000-000000001102', 'google-l03-retier-free', 'Synthetic Retier Free Owner', current_timestamp, current_timestamp);

begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000001102', true);
select * from app_private.create_channel(
  '00000000-0000-4000-8000-000000001122',
  '00000000-0000-4000-8000-000000001102', 'retier_free_test', 'Retier Free Test'
);
commit;

do $$
declare
  free_values jsonb;
begin
  select values into free_values
    from channel_entitlement_versions
   where channel_id = '00000000-0000-4000-8000-000000001122'
   order by version desc limit 1;
  if (free_values ->> 'queueCount')::int <> 1
     or (free_values ->> 'ttsEnabled')::boolean is distinct from false
     or (free_values ->> 'maxVisibleItems')::int <> 3
     or (free_values ->> 'maxCharLimit')::int <> 100
     or (free_values ->> 'maxDisplayMs')::int <> 6000
     or (free_values ->> 'quietMode')::boolean is distinct from false
     or (free_values ->> 'approvalRequired')::boolean is distinct from false then
    raise exception 'new free channel did not receive all eight dimensions: %', free_values;
  end if;
end
$$;
