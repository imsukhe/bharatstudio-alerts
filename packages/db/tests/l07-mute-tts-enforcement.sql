-- L07 Companion TTS mute ENFORCEMENT (0101), as distinct from mute STATE
-- (already covered by l07_companion_feature_reads.sql / 0098). This file
-- proves the actual bug the task describes: a muted queue's overlay must
-- not receive TTS audio, unmuting restores it, and cancel (a different
-- operation, on a different target) only ever affects the one delivery it
-- names. Synthetic identifiers only; own fixture ids
-- 00000000-...-00000000a001 upward, distinct from every other test file's
-- range.
--
-- RT-02/0127: get_overlay_events no longer bakes `ttsAudioUrl` into the
-- jsonb payload (a shared/deduplicated replay must never leak one session's
-- overlayId into another's URL); it returns the resolved artifact id as its
-- own `tts_audio_artifact_id` column instead, under the exact same
-- mute-aware null this file already proves. Every assertion below reads
-- that column now; nothing about what mute enforcement means changed.

\set ON_ERROR_STOP on

insert into app_users (id, external_subject, display_name, created_at, updated_at)
values ('00000000-0000-4000-8000-00000000a001', 'google-l07mute-owner', 'Synthetic L07 Mute Owner', current_timestamp, current_timestamp)
on conflict (id) do nothing;

begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-00000000a001', true);
select * from app_private.create_channel(
  '00000000-0000-4000-8000-00000000a011',
  '00000000-0000-4000-8000-00000000a001', 'l07mute_channel', 'L07 Mute Test Channel'
);
commit;

-- Creator tier: ttsEnabled = true (required by both set_companion_tts_mute
-- and get_alert_tts_input).
update channel_entitlement_versions
   set tier = 'creator', values = values || jsonb_build_object('ttsEnabled', true, 'maxCharLimit', 250)
 where channel_id = '00000000-0000-4000-8000-00000000a011';

update channel_configs
   set values = '{"locale":"en-IN","tts":{"enabled":true},"brackets":[{"amountMinPaise":1000,"amountMaxPaise":null,"ttsEligible":true,"charLimit":250}]}'::jsonb
 where channel_id = '00000000-0000-4000-8000-00000000a011' and version = 1;

insert into alert_queues (id, channel_id, name, created_at, updated_at)
values
  ('00000000-0000-4000-8000-00000000a021', '00000000-0000-4000-8000-00000000a011', 'Mute test queue', current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-00000000a022', '00000000-0000-4000-8000-00000000a011', 'Sibling queue (never muted)', current_timestamp, current_timestamp);

insert into overlay_sessions (id, channel_id, token_fingerprint, expires_at, created_at)
values ('00000000-0000-4000-8000-00000000a031', '00000000-0000-4000-8000-00000000a011', 'fingerprint-l07-mute', current_timestamp + interval '1 hour', current_timestamp);

-- Two manual alerts, each fanned out to BOTH queues: one queue gets muted,
-- the other never does, on the SAME two events — proving mute is scoped
-- to the queue's own delivery, not to the event or the channel.
begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-00000000a001', true);
select * from app_private.create_manual_alert(
  '00000000-0000-0000-0000-00000000a041', '00000000-0000-0000-0000-00000000a042',
  '00000000-0000-4000-8000-00000000a011', '00000000-0000-4000-8000-00000000a001',
  'trace-l07-mute-a', 1,
  jsonb_build_object('displayName', 'Muted Viewer', 'message', 'hello', 'amountPaise', '20000',
    'queueIds', jsonb_build_array('00000000-0000-4000-8000-00000000a021', '00000000-0000-4000-8000-00000000a022'))
);
commit;

-- Synthesize audio for the event (shared across both queues' deliveries,
-- exactly as production does — see this migration's own header comment on
-- why synthesis is event-scoped, not queue-scoped).
do $$
begin
  perform app_private.store_alert_tts_audio(
    '00000000-0000-0000-0000-00000000a041'::uuid,
    decode(repeat('00', 100), 'hex'), 'audio/wav', 1500, 'cache-key-l07-mute-a'
  );
end
$$;

-- Before muting: both queues' deliveries carry the TTS url.
begin;
set local role bsa_app;
select set_config('app.overlay_session_id', '00000000-0000-4000-8000-00000000a031', true);
do $$
declare
  muted_artifact_id text;
  sibling_artifact_id text;
begin
  select tts_audio_artifact_id::text into muted_artifact_id
    from app_private.get_overlay_events('00000000-0000-4000-8000-00000000a031', null, null, 50)
   where event_id = '00000000-0000-0000-0000-00000000a041' and (payload ->> 'queueId')::uuid = '00000000-0000-4000-8000-00000000a021';
  select tts_audio_artifact_id::text into sibling_artifact_id
    from app_private.get_overlay_events('00000000-0000-4000-8000-00000000a031', null, null, 50)
   where event_id = '00000000-0000-0000-0000-00000000a041' and (payload ->> 'queueId')::uuid = '00000000-0000-4000-8000-00000000a022';
  if muted_artifact_id is null then raise exception 'pre-mute: target queue unexpectedly had no TTS artifact id'; end if;
  if sibling_artifact_id is null then raise exception 'pre-mute: sibling queue unexpectedly had no TTS artifact id'; end if;
end
$$;
commit;

-- Mute the first queue only.
do $$
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-00000000a001', true);
  perform app_private.set_companion_tts_mute(
    '00000000-0000-4000-8000-00000000a011'::uuid, '00000000-0000-4000-8000-00000000a001'::uuid,
    '00000000-0000-4000-8000-00000000a021'::uuid, true
  );
end
$$;

-- After muting: the muted queue's delivery has no TTS audio, but the
-- alert row itself (visual) still comes through, AND the sibling queue's
-- delivery for the SAME event is untouched.
begin;
set local role bsa_app;
select set_config('app.overlay_session_id', '00000000-0000-4000-8000-00000000a031', true);
do $$
declare
  muted_artifact_id text;
  muted_duration text;
  sibling_artifact_id text;
  muted_row_exists boolean;
begin
  select (count(*) > 0) into muted_row_exists
    from app_private.get_overlay_events('00000000-0000-4000-8000-00000000a031', null, null, 50)
   where event_id = '00000000-0000-0000-0000-00000000a041' and (payload ->> 'queueId')::uuid = '00000000-0000-4000-8000-00000000a021';
  if not muted_row_exists then
    raise exception 'muting suppressed the whole alert delivery, not just the TTS audio';
  end if;

  select tts_audio_artifact_id::text, payload ->> 'ttsAudioDurationMs' into muted_artifact_id, muted_duration
    from app_private.get_overlay_events('00000000-0000-4000-8000-00000000a031', null, null, 50)
   where event_id = '00000000-0000-0000-0000-00000000a041' and (payload ->> 'queueId')::uuid = '00000000-0000-4000-8000-00000000a021';
  if muted_artifact_id is not null then raise exception 'muted queue still carried a TTS artifact id: %', muted_artifact_id; end if;
  if muted_duration is not null then raise exception 'muted queue still carried a ttsAudioDurationMs: %', muted_duration; end if;

  select tts_audio_artifact_id::text into sibling_artifact_id
    from app_private.get_overlay_events('00000000-0000-4000-8000-00000000a031', null, null, 50)
   where event_id = '00000000-0000-0000-0000-00000000a041' and (payload ->> 'queueId')::uuid = '00000000-0000-4000-8000-00000000a022';
  if sibling_artifact_id is null then raise exception 'muting one queue incorrectly silenced the sibling (non-muted) queue too';
  end if;
end
$$;
commit;

-- Unmute restores audio for new deliveries on that queue.
do $$
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-00000000a001', true);
  perform app_private.set_companion_tts_mute(
    '00000000-0000-4000-8000-00000000a011'::uuid, '00000000-0000-4000-8000-00000000a001'::uuid,
    '00000000-0000-4000-8000-00000000a021'::uuid, false
  );
end
$$;

begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-00000000a001', true);
select * from app_private.create_manual_alert(
  '00000000-0000-0000-0000-00000000a043', '00000000-0000-0000-0000-00000000a044',
  '00000000-0000-4000-8000-00000000a011', '00000000-0000-4000-8000-00000000a001',
  'trace-l07-mute-b', 1,
  jsonb_build_object('displayName', 'Unmuted Viewer', 'message', 'again', 'amountPaise', '20000',
    'queueIds', jsonb_build_array('00000000-0000-4000-8000-00000000a021'))
);
commit;

do $$
begin
  perform app_private.store_alert_tts_audio(
    '00000000-0000-0000-0000-00000000a043'::uuid,
    decode(repeat('00', 100), 'hex'), 'audio/wav', 1500, 'cache-key-l07-mute-b'
  );
end
$$;

begin;
set local role bsa_app;
select set_config('app.overlay_session_id', '00000000-0000-4000-8000-00000000a031', true);
do $$
declare
  restored_artifact_id text;
begin
  select tts_audio_artifact_id::text into restored_artifact_id
    from app_private.get_overlay_events('00000000-0000-4000-8000-00000000a031', null, null, 50)
   where event_id = '00000000-0000-0000-0000-00000000a043';
  if restored_artifact_id is null then raise exception 'unmuting did not restore the TTS artifact id for a new delivery'; end if;
end
$$;
commit;

-- === Cancel is a DIFFERENT operation on a DIFFERENT target: it removes
-- one specific in-flight delivery entirely (visual + audio), never the
-- whole event, and never any other queue's delivery of that same event.
-- (0098 already made this work via the status filter in get_overlay_events
-- -- this proves it, since 0101 redefined that function and must not have
-- regressed it.)
begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-00000000a001', true);
select * from app_private.create_manual_alert(
  '00000000-0000-0000-0000-00000000a045', '00000000-0000-0000-0000-00000000a046',
  '00000000-0000-4000-8000-00000000a011', '00000000-0000-4000-8000-00000000a001',
  'trace-l07-cancel', 1,
  jsonb_build_object('displayName', 'Cancel Viewer', 'message', 'cancel me', 'amountPaise', '20000',
    'queueIds', jsonb_build_array('00000000-0000-4000-8000-00000000a021', '00000000-0000-4000-8000-00000000a022'))
);
commit;

do $$
declare
  target_delivery uuid;
  other_delivery uuid;
begin
  select delivery.id into target_delivery
    from event_outbox_deliveries delivery
   where delivery.event_id = '00000000-0000-0000-0000-00000000a045' and delivery.queue_id = '00000000-0000-4000-8000-00000000a021';
  select delivery.id into other_delivery
    from event_outbox_deliveries delivery
   where delivery.event_id = '00000000-0000-0000-0000-00000000a045' and delivery.queue_id = '00000000-0000-4000-8000-00000000a022';

  perform set_config('app.user_id', '00000000-0000-4000-8000-00000000a001', true);
  perform app_private.cancel_companion_tts_delivery(
    '00000000-0000-4000-8000-00000000a011'::uuid, '00000000-0000-4000-8000-00000000a001'::uuid, target_delivery
  );

  if (select status from event_outbox_deliveries where id = target_delivery) <> 'tts_cancelled' then
    raise exception 'cancel did not transition the targeted delivery to tts_cancelled';
  end if;
  if (select status from event_outbox_deliveries where id = other_delivery) = 'tts_cancelled' then
    raise exception 'cancel affected the sibling delivery, not just the one it targeted';
  end if;
end
$$;

begin;
set local role bsa_app;
select set_config('app.overlay_session_id', '00000000-0000-4000-8000-00000000a031', true);
do $$
declare
  cancelled_row_exists boolean;
  sibling_row_exists boolean;
begin
  select (count(*) > 0) into cancelled_row_exists
    from app_private.get_overlay_events('00000000-0000-4000-8000-00000000a031', null, null, 50)
   where event_id = '00000000-0000-0000-0000-00000000a045' and (payload ->> 'queueId')::uuid = '00000000-0000-4000-8000-00000000a021';
  if cancelled_row_exists then
    raise exception 'a cancelled delivery still appeared in the overlay stream';
  end if;

  select (count(*) > 0) into sibling_row_exists
    from app_private.get_overlay_events('00000000-0000-4000-8000-00000000a031', null, null, 50)
   where event_id = '00000000-0000-0000-0000-00000000a045' and (payload ->> 'queueId')::uuid = '00000000-0000-4000-8000-00000000a022';
  if not sibling_row_exists then
    raise exception 'cancelling one queue''s delivery removed the sibling queue''s delivery of the same event too';
  end if;
end
$$;
commit;

select 'L07_MUTE_TTS_ENFORCEMENT=PASS' as result;
