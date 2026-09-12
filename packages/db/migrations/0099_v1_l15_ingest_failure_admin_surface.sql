-- Operator read/acknowledge surface for permanently-failed YouTube ingests.
--
-- 0094 created youtube_event_ingest_failures, written by
-- app_private.record_youtube_ingest_failure when the poller hits a PERMANENT
-- error (SQLSTATE class 22/23). The table has RLS with `revoke all from public`
-- and no SELECT policy, so nothing — not even bsa_app — can read a row. That was
-- correct for an insert-only evidence table, but it left operators unable to see
-- failures at all except through direct superuser access.
--
-- DISPOSITION IS ACKNOWLEDGE-ONLY, NOT REPLAY OR DISCARD, and that is deliberate:
--   * Replay cannot work. A row here is by definition a constraint or validation
--     failure; re-running the identical payload through record_youtube_alert_event
--     fails the same check again. Offering a replay button would imply a recovery
--     path that does not exist and would mask a real bug as "handled".
--   * Discard is meaningless. Unlike a DLQ delivery, this row never created an
--     alert_events or event_outbox row, so nothing downstream is stuck waiting on
--     it. There is no queue to unblock.
-- What an operator actually needs is to see it, understand it, and record that a
-- human looked. Hence acknowledge.
--
-- The table keeps its no-direct-read posture: these three SECURITY DEFINER
-- functions are the only way in, each gated by is_platform_admin(), following the
-- admin DLQ precedent in 0073 exactly.
--
-- NOTE ON payload: the jsonb payload column is deliberately NOT projected by any
-- of these functions. It holds raw upstream event content and is the one field
-- most likely to carry viewer-identifying data. Operators get "what failed and
-- where", never the content — the same "what and where, not content" line 0073
-- draws for the DLQ.

alter table public.youtube_event_ingest_failures
  add column if not exists acknowledged_at timestamptz,
  add column if not exists acknowledged_by_user_id uuid references public.app_users(id),
  add column if not exists acknowledgement_note text
    check (acknowledgement_note is null or char_length(acknowledgement_note) between 1 and 1000);

-- The existing index is (channel_id, created_at desc); admin listing is global and
-- keyset-paginated on (created_at desc, id desc), so it needs its own.
create index if not exists youtube_event_ingest_failures_admin_idx
  on public.youtube_event_ingest_failures (created_at desc, id desc);

create or replace function app_private.list_youtube_ingest_failures(
  cursor_created_at timestamptz,
  cursor_id uuid,
  target_limit integer
)
returns table (
  id uuid,
  channel_id uuid,
  channel_handle text,
  source_id text,
  source_event_type text,
  sqlstate_code text,
  error_detail text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if not app_private.is_platform_admin() then
    raise exception 'platform admin required' using errcode = '42501';
  end if;
  if target_limit is null or target_limit < 1 or target_limit > 200 then
    raise exception 'invalid ingest failure page size: %', target_limit using errcode = '22023';
  end if;

  return query
    select failure.id, failure.channel_id, channel.handle,
           failure.source_id, failure.source_event_type,
           failure.sqlstate_code, failure.error_detail, failure.created_at
      from public.youtube_event_ingest_failures failure
      join public.channels channel on channel.id = failure.channel_id
     where cursor_created_at is null
        or (failure.created_at, failure.id) < (cursor_created_at, cursor_id)
     order by failure.created_at desc, failure.id desc
     limit target_limit;
end
$$;

create or replace function app_private.get_youtube_ingest_failure(target_id uuid)
returns table (
  id uuid,
  channel_id uuid,
  channel_handle text,
  source_id text,
  source_event_type text,
  sqlstate_code text,
  error_detail text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if not app_private.is_platform_admin() then
    raise exception 'platform admin required' using errcode = '42501';
  end if;

  return query
    select failure.id, failure.channel_id, channel.handle,
           failure.source_id, failure.source_event_type,
           failure.sqlstate_code, failure.error_detail, failure.created_at
      from public.youtube_event_ingest_failures failure
      join public.channels channel on channel.id = failure.channel_id
     where failure.id = target_id;
end
$$;

create or replace function app_private.acknowledge_youtube_ingest_failure(
  target_id uuid,
  admin_user_id uuid,
  note text
)
returns table (id uuid, acknowledged_at timestamptz)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  already timestamptz;
begin
  if not app_private.is_platform_admin() then
    raise exception 'platform admin required' using errcode = '42501';
  end if;

  select failure.acknowledged_at into already
    from public.youtube_event_ingest_failures failure
   where failure.id = target_id
     for update;

  if not found then
    raise exception 'unknown ingest failure: %', target_id using errcode = '22023';
  end if;
  if already is not null then
    raise exception 'ingest failure already acknowledged: %', target_id using errcode = '22023';
  end if;

  return query
    update public.youtube_event_ingest_failures failure
       set acknowledged_at = current_timestamp,
           acknowledged_by_user_id = admin_user_id,
           acknowledgement_note = note
     where failure.id = target_id
    returning failure.id, failure.acknowledged_at;
end
$$;

revoke execute on function app_private.list_youtube_ingest_failures(timestamptz, uuid, integer) from public;
revoke execute on function app_private.get_youtube_ingest_failure(uuid) from public;
revoke execute on function app_private.acknowledge_youtube_ingest_failure(uuid, uuid, text) from public;

grant execute on function app_private.list_youtube_ingest_failures(timestamptz, uuid, integer) to bsa_app;
grant execute on function app_private.get_youtube_ingest_failure(uuid) to bsa_app;
grant execute on function app_private.acknowledge_youtube_ingest_failure(uuid, uuid, text) to bsa_app;
