-- L03 TTS integration. Audio is an optional enrichment of an already durable
-- alert event. Failure to create an artifact must never change delivery state.

create table if not exists public.alert_tts_audio (
  id uuid primary key,
  event_id uuid not null unique references public.alert_events(id),
  audio_bytes bytea not null,
  mime_type text not null check (mime_type = 'audio/wav'),
  duration_ms integer check (duration_ms is null or duration_ms between 1 and 60000),
  cache_key text not null,
  created_at timestamptz not null default current_timestamp,
  check (octet_length(audio_bytes) between 1 and 2000000)
);

create table if not exists public.alert_tts_cache (
  cache_key text primary key check (cache_key ~ '^[0-9a-f]{64}$'),
  audio_bytes bytea not null,
  mime_type text not null check (mime_type = 'audio/wav'),
  duration_ms integer check (duration_ms is null or duration_ms between 1 and 60000),
  created_at timestamptz not null default current_timestamp,
  check (octet_length(audio_bytes) between 1 and 2000000)
);

alter table public.alert_tts_audio enable row level security;
revoke all on public.alert_tts_audio from public;
revoke all on public.alert_tts_audio from bsa_app;
revoke all on public.alert_tts_audio from bsa_alert_worker;
alter table public.alert_tts_cache enable row level security;
revoke all on public.alert_tts_cache from public;
revoke all on public.alert_tts_cache from bsa_app;
revoke all on public.alert_tts_cache from bsa_alert_worker;

create or replace function app_private.get_alert_tts_input(target_event_id uuid)
returns table (
  event_id uuid,
  message text,
  locale text,
  voice_id text,
  model text,
  enabled boolean,
  eligible boolean
)
language sql stable security definer
set search_path = pg_catalog, public, app_private
as $$
  with source_event as (
    select event.id, event.payload, event.channel_id, event.config_snapshot_version
      from public.alert_events event
     where event.id = target_event_id
  ), config as (
    select source_event.*, coalesce(channel_config.values, '{}'::jsonb) as values
      from source_event
      left join public.channel_configs channel_config
        on channel_config.channel_id = source_event.channel_id
       and channel_config.version = source_event.config_snapshot_version
  ), bracket as (
    select config.*, item as bracket
      from config
      left join lateral jsonb_array_elements(coalesce(config.values -> 'brackets', '[]'::jsonb)) item on true
     where (item is null
        or ((item ->> 'amountMinPaise') ~ '^[0-9]+$'
        and (config.payload ->> 'amountPaise') ~ '^[0-9]+$'
        and (item ->> 'amountMinPaise')::bigint <= (config.payload ->> 'amountPaise')::bigint
        and (item ->> 'amountMaxPaise') is null
        or ((item ->> 'amountMaxPaise') ~ '^[0-9]+$'
        and (config.payload ->> 'amountPaise') ~ '^[0-9]+$'
        and (item ->> 'amountMinPaise')::bigint <= (config.payload ->> 'amountPaise')::bigint
        and (item ->> 'amountMaxPaise')::bigint >= (config.payload ->> 'amountPaise')::bigint)))
     order by case when item is null then 0 else 1 end, (item ->> 'amountMinPaise')::bigint desc nulls last
     limit 1
  )
  select id,
         left(coalesce(payload ->> 'message', ''), 500),
         coalesce(nullif(values ->> 'locale', ''), 'en-IN'),
         nullif(values -> 'tts' ->> 'voiceId', ''),
         nullif(values -> 'tts' ->> 'model', ''),
         coalesce((values -> 'tts' ->> 'enabled')::boolean, false),
         coalesce((bracket ->> 'ttsEligible')::boolean, true)
    from bracket
   where coalesce((values -> 'tts' ->> 'enabled')::boolean, false)
     and coalesce((bracket ->> 'ttsEligible')::boolean, true)
$$;

create or replace function app_private.store_alert_tts_audio(
  target_event_id uuid,
  target_audio_bytes bytea,
  target_mime_type text,
  target_duration_ms integer,
  target_cache_key text
)
returns uuid
language plpgsql volatile security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  artifact_id uuid;
begin
  if target_event_id is null
     or target_audio_bytes is null
     or octet_length(target_audio_bytes) not between 1 and 2000000
     or target_mime_type <> 'audio/wav'
     or target_cache_key is null
     or char_length(target_cache_key) > 128
     or (target_duration_ms is not null and (target_duration_ms < 1 or target_duration_ms > 60000)) then
    raise exception 'invalid TTS artifact' using errcode = '22023';
  end if;

  insert into public.alert_tts_audio (id, event_id, audio_bytes, mime_type, duration_ms, cache_key)
  values (gen_random_uuid(), target_event_id, target_audio_bytes, target_mime_type, target_duration_ms, target_cache_key)
  on conflict (event_id) do update
    set audio_bytes = excluded.audio_bytes,
        mime_type = excluded.mime_type,
        duration_ms = excluded.duration_ms,
        cache_key = excluded.cache_key,
        created_at = current_timestamp
  returning id into artifact_id;

  update public.alert_events
     set payload = payload || jsonb_build_object(
       'ttsAudioArtifactId', artifact_id::text,
       'ttsAudioDurationMs', target_duration_ms
     )
   where id = target_event_id;
  return artifact_id;
end
$$;

create or replace function app_private.get_alert_tts_cache(target_cache_key text)
returns table (audio_bytes bytea, mime_type text, duration_ms integer, cache_key text)
language sql stable security definer
set search_path = pg_catalog, public, app_private
as $$
  select audio_bytes, mime_type, duration_ms, cache_key
    from public.alert_tts_cache
   where cache_key = target_cache_key
$$;

create or replace function app_private.put_alert_tts_cache(
  target_cache_key text,
  target_audio_bytes bytea,
  target_mime_type text,
  target_duration_ms integer
)
returns void
language plpgsql volatile security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if target_cache_key is null or target_cache_key !~ '^[0-9a-f]{64}$'
     or target_audio_bytes is null
     or octet_length(target_audio_bytes) not between 1 and 2000000
     or target_mime_type <> 'audio/wav'
     or (target_duration_ms is not null and (target_duration_ms < 1 or target_duration_ms > 60000)) then
    raise exception 'invalid TTS cache artifact' using errcode = '22023';
  end if;
  insert into public.alert_tts_cache (cache_key, audio_bytes, mime_type, duration_ms)
  values (target_cache_key, target_audio_bytes, target_mime_type, target_duration_ms)
  on conflict (cache_key) do update
    set audio_bytes = excluded.audio_bytes,
        mime_type = excluded.mime_type,
        duration_ms = excluded.duration_ms,
        created_at = current_timestamp;
end
$$;

create or replace function app_private.get_overlay_tts_audio(
  target_overlay_id uuid,
  target_token_fingerprint text,
  target_artifact_id uuid
)
returns table (audio_bytes bytea, mime_type text, duration_ms integer)
language sql stable security definer
set search_path = pg_catalog, public, app_private
as $$
  select artifact.audio_bytes, artifact.mime_type, artifact.duration_ms
    from public.overlay_sessions session
    join public.alert_events event on event.channel_id = session.channel_id
    join public.alert_tts_audio artifact on artifact.event_id = event.id
   where session.id = target_overlay_id
     and session.token_fingerprint = target_token_fingerprint
     and session.revoked_at is null
     and session.expires_at > current_timestamp
     and artifact.id = target_artifact_id
$$;

revoke execute on function app_private.get_alert_tts_input(uuid) from public;
revoke execute on function app_private.store_alert_tts_audio(uuid, bytea, text, integer, text) from public;
revoke execute on function app_private.get_overlay_tts_audio(uuid, text, uuid) from public;
revoke execute on function app_private.get_alert_tts_cache(text) from public;
revoke execute on function app_private.put_alert_tts_cache(text, bytea, text, integer) from public;
grant execute on function app_private.get_alert_tts_input(uuid) to bsa_app;
grant execute on function app_private.store_alert_tts_audio(uuid, bytea, text, integer, text) to bsa_app;
grant execute on function app_private.get_overlay_tts_audio(uuid, text, uuid) to bsa_app;
grant execute on function app_private.get_alert_tts_cache(text) to bsa_app;
grant execute on function app_private.put_alert_tts_cache(text, bytea, text, integer) to bsa_app;

create or replace function app_private.get_overlay_events(
  target_overlay_id uuid, target_after_created_at timestamptz,
  target_after_delivery_id uuid, target_limit integer
)
returns table (cursor text, event_id uuid, event_type text, trace_id text,
  created_at timestamptz, payload jsonb)
language sql stable security definer
set search_path = pg_catalog, public, app_private
as $$
  select to_char(delivery.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || delivery.id::text,
         event.id, case when delivery.status = 'held' then 'alert.hold' else 'alert.ready' end,
         event.trace_id, delivery.created_at,
         event.payload || jsonb_build_object('deliveryId', delivery.id, 'queueId', delivery.queue_id,
           'bindingId', delivery.binding_id, 'configSnapshotVersion', delivery.config_snapshot_version,
           'configSnapshot', coalesce(config.values, '{}'::jsonb), 'deliverySequence', delivery.delivery_sequence,
           'sourcePriority', delivery.source_priority, 'overrideValues', coalesce(delivery.override_values, '{}'::jsonb),
           'ttsAudioUrl', case when artifact.id is null then null else '/v1/overlay-audio/' || target_overlay_id::text || '/' || artifact.id::text end,
           'ttsAudioDurationMs', artifact.duration_ms)
    from public.event_outbox_deliveries delivery
    join public.event_outbox outbox on outbox.id = delivery.outbox_id
    join public.alert_events event on event.id = delivery.event_id
    left join public.channel_configs config on config.channel_id = event.channel_id and config.version = delivery.config_snapshot_version
    left join public.alert_tts_audio artifact on artifact.id = case
      when event.payload ->> 'ttsAudioArtifactId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      then (event.payload ->> 'ttsAudioArtifactId')::uuid
      else null
    end
    join public.overlay_sessions session on session.id = target_overlay_id
    join public.alert_queues queue on queue.id = delivery.queue_id and queue.closed_at is null and queue.is_paused = false
   where target_overlay_id = app_private.current_overlay_session_id()
     and session.id = target_overlay_id and event.channel_id = session.channel_id
   and session.revoked_at is null and session.expires_at > current_timestamp
     and delivery.status in ('ready', 'displayed')
   and app_private.delivery_dispatch_allowed(delivery.event_id, delivery.config_snapshot_version)
   order by delivery.created_at asc, delivery.id asc
   limit greatest(1, least(target_limit, 100))
$$;

revoke execute on function app_private.get_overlay_events(uuid, timestamptz, uuid, integer) from public;
grant execute on function app_private.get_overlay_events(uuid, timestamptz, uuid, integer) to bsa_app;
