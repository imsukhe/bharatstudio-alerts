-- RT-02 / migration 0127: app_private.get_overlay_events now returns the
-- resolved TTS artifact id as its OWN column (`tts_audio_artifact_id`)
-- instead of baking a session-specific `ttsAudioUrl` into the jsonb payload
-- -- the mechanism that makes a per-channel shared/deduplicated replay safe
-- (apps/api composes the URL per session from this id). This file proves:
--
--   1. the new column resolves the artifact id for a delivery that has one;
--   2. it is null when no artifact row exists;
--   3. a muted queue still yields a null artifact id (0101 behaviour,
--      unaffected by 0127's column move);
--   4. every other filter the function already enforced is unchanged:
--      revoked session, expired session, paused queue, closed queue,
--      suppressed (dispatch_allowed = false) delivery, cancelled
--      (tts_cancelled) delivery, and channel scoping.
--
-- Own synthetic id range: 00000000-0000-4000-8000-00000000b0xx, distinct
-- from every other test file's range.

\set ON_ERROR_STOP on

insert into app_users (id, external_subject, display_name, created_at, updated_at)
values ('00000000-0000-4000-8000-00000000b001', 'google-rt02-owner', 'Synthetic RT-02 Owner', current_timestamp, current_timestamp)
on conflict (id) do nothing;

begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-00000000b001', true);
select * from app_private.create_channel('00000000-0000-4000-8000-00000000b011', '00000000-0000-4000-8000-00000000b001', 'rt02_channel_a', 'RT-02 Channel A');
select * from app_private.create_channel('00000000-0000-4000-8000-00000000b012', '00000000-0000-4000-8000-00000000b001', 'rt02_channel_b', 'RT-02 Channel B');
commit;

-- Both cancel_companion_tts_delivery and set_companion_tts_mute (used below)
-- require TTS entitlement on the channel, same as l07-mute-tts-enforcement.sql.
update channel_entitlement_versions
   set tier = 'creator', values = values || jsonb_build_object('ttsEnabled', true, 'maxCharLimit', 250)
 where channel_id = '00000000-0000-4000-8000-00000000b011';

insert into alert_queues (id, channel_id, name, is_paused, closed_at, created_at, updated_at)
values
  ('00000000-0000-4000-8000-00000000b021', '00000000-0000-4000-8000-00000000b011', 'Open queue', false, null, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-00000000b022', '00000000-0000-4000-8000-00000000b011', 'Paused queue', true, null, current_timestamp, current_timestamp),
  -- Starts open: app_private.create_manual_alert itself refuses a closed
  -- queue at creation time (0019), so this queue is closed AFTER its
  -- delivery is created below, to prove get_overlay_events excludes an
  -- existing delivery once its queue closes.
  ('00000000-0000-4000-8000-00000000b023', '00000000-0000-4000-8000-00000000b011', 'Closes after its delivery exists', false, null, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-00000000b024', '00000000-0000-4000-8000-00000000b012', 'Channel B open queue', false, null, current_timestamp, current_timestamp);

insert into overlay_sessions (id, channel_id, token_fingerprint, expires_at, revoked_at, created_at)
values
  ('00000000-0000-4000-8000-00000000b031', '00000000-0000-4000-8000-00000000b011', 'fingerprint-rt02-valid', current_timestamp + interval '1 hour', null, current_timestamp),
  ('00000000-0000-4000-8000-00000000b032', '00000000-0000-4000-8000-00000000b011', 'fingerprint-rt02-revoked', current_timestamp + interval '1 hour', current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-00000000b033', '00000000-0000-4000-8000-00000000b011', 'fingerprint-rt02-expired', current_timestamp - interval '1 hour', null, current_timestamp),
  ('00000000-0000-4000-8000-00000000b034', '00000000-0000-4000-8000-00000000b012', 'fingerprint-rt02-channel-b', current_timestamp + interval '1 hour', null, current_timestamp);

-- Alert 1: open queue, with a stored TTS artifact -- proves the new column
-- resolves it. Alert 2: open queue, no artifact -- proves null.
begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-00000000b001', true);
select * from app_private.create_manual_alert(
  '00000000-0000-0000-0000-00000000b041', '00000000-0000-0000-0000-00000000b042',
  '00000000-0000-4000-8000-00000000b011', '00000000-0000-4000-8000-00000000b001',
  'trace-rt02-with-artifact', 1,
  jsonb_build_object('displayName', 'Artifact Viewer', 'message', 'has audio', 'amountPaise', '20000',
    'queueIds', jsonb_build_array('00000000-0000-4000-8000-00000000b021'))
);
select * from app_private.create_manual_alert(
  '00000000-0000-0000-0000-00000000b043', '00000000-0000-0000-0000-00000000b044',
  '00000000-0000-4000-8000-00000000b011', '00000000-0000-4000-8000-00000000b001',
  'trace-rt02-no-artifact', 1,
  jsonb_build_object('displayName', 'No Artifact Viewer', 'message', 'no audio', 'amountPaise', '20000',
    'queueIds', jsonb_build_array('00000000-0000-4000-8000-00000000b021'))
);
-- Alert 3/4: targeted at the paused/closed queues -- must never appear.
select * from app_private.create_manual_alert(
  '00000000-0000-0000-0000-00000000b045', '00000000-0000-0000-0000-00000000b046',
  '00000000-0000-4000-8000-00000000b011', '00000000-0000-4000-8000-00000000b001',
  'trace-rt02-paused-queue', 1,
  jsonb_build_object('displayName', 'Paused Viewer', 'message', 'paused', 'amountPaise', '20000',
    'queueIds', jsonb_build_array('00000000-0000-4000-8000-00000000b022'))
);
select * from app_private.create_manual_alert(
  '00000000-0000-0000-0000-00000000b047', '00000000-0000-0000-0000-00000000b048',
  '00000000-0000-4000-8000-00000000b011', '00000000-0000-4000-8000-00000000b001',
  'trace-rt02-closed-queue', 1,
  jsonb_build_object('displayName', 'Closed Viewer', 'message', 'closed', 'amountPaise', '20000',
    'queueIds', jsonb_build_array('00000000-0000-4000-8000-00000000b023'))
);
-- Alert 5: open queue, then suppressed by moderation -- dispatch_allowed
-- must exclude it.
select * from app_private.create_manual_alert(
  '00000000-0000-0000-0000-00000000b049', '00000000-0000-0000-0000-00000000b04a',
  '00000000-0000-4000-8000-00000000b011', '00000000-0000-4000-8000-00000000b001',
  'trace-rt02-suppressed', 1,
  jsonb_build_object('displayName', 'Suppressed Viewer', 'message', 'suppressed', 'amountPaise', '20000',
    'queueIds', jsonb_build_array('00000000-0000-4000-8000-00000000b021'))
);
insert into alert_moderation_actions (id, event_id, channel_id, actor_user_id, action, created_at)
values ('00000000-0000-4000-8000-00000000b051', '00000000-0000-0000-0000-00000000b049', '00000000-0000-4000-8000-00000000b011', '00000000-0000-4000-8000-00000000b001', 'suppress', current_timestamp);
-- Alert 6: open queue, then its delivery is explicitly cancelled -- the
-- status filter must exclude it (same mechanism l07-mute-tts-enforcement.sql
-- proves; re-checked here alongside the new column).
select * from app_private.create_manual_alert(
  '00000000-0000-0000-0000-00000000b04b', '00000000-0000-0000-0000-00000000b04c',
  '00000000-0000-4000-8000-00000000b011', '00000000-0000-4000-8000-00000000b001',
  'trace-rt02-cancelled', 1,
  jsonb_build_object('displayName', 'Cancelled Viewer', 'message', 'cancelled', 'amountPaise', '20000',
    'queueIds', jsonb_build_array('00000000-0000-4000-8000-00000000b021'))
);
-- Alert on channel B -- proves channel scoping: channel A's session must
-- never see it, and channel B's session must see only it.
select * from app_private.create_manual_alert(
  '00000000-0000-0000-0000-00000000b04d', '00000000-0000-0000-0000-00000000b04e',
  '00000000-0000-4000-8000-00000000b012', '00000000-0000-4000-8000-00000000b001',
  'trace-rt02-channel-b', 1,
  jsonb_build_object('displayName', 'Channel B Viewer', 'message', 'other channel', 'amountPaise', '20000',
    'queueIds', jsonb_build_array('00000000-0000-4000-8000-00000000b024'))
);
commit;

-- Close queue b023 now that alert 4's delivery exists on it.
update alert_queues set closed_at = current_timestamp where id = '00000000-0000-4000-8000-00000000b023';

do $$
declare
  v_artifact_id uuid;
begin
  v_artifact_id := app_private.store_alert_tts_audio(
    '00000000-0000-0000-0000-00000000b041'::uuid,
    decode(repeat('00', 100), 'hex'), 'audio/wav', 1500, 'cache-key-rt02-a'
  );
  perform app_private.store_alert_tts_audio(
    '00000000-0000-0000-0000-00000000b04d'::uuid,
    decode(repeat('00', 100), 'hex'), 'audio/wav', 1500, 'cache-key-rt02-b'
  );
end
$$;

-- Captured here, at the top level as the connecting (superuser) role, into a
-- temp table -- bsa_app has no direct grant on alert_tts_audio (0067; reads
-- go only through app_private.get_overlay_events, which is exactly what
-- this file is proving), so this is granted to bsa_app explicitly, scoped
-- to this session/throwaway database only.
create temporary table rt02_expected_artifact (artifact_id uuid);
insert into rt02_expected_artifact (artifact_id)
select id from alert_tts_audio where event_id = '00000000-0000-0000-0000-00000000b041';
grant select on rt02_expected_artifact to bsa_app;

do $$
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-00000000b001', true);
  perform app_private.cancel_companion_tts_delivery(
    '00000000-0000-4000-8000-00000000b011'::uuid, '00000000-0000-4000-8000-00000000b001'::uuid,
    (select id from event_outbox_deliveries where event_id = '00000000-0000-0000-0000-00000000b04b')
  );
end
$$;

-- 1/2/3: artifact id present, artifact id null, and (via the paused/closed/
-- suppressed/cancelled rows all being absent) status + dispatch_allowed +
-- queue-state filters unchanged.
begin;
set local role bsa_app;
select set_config('app.overlay_session_id', '00000000-0000-4000-8000-00000000b031', true);
do $$
declare
  v_artifact_id uuid;
  v_expected_artifact_id uuid;
  v_row_count integer;
begin
  select artifact_id into v_expected_artifact_id from rt02_expected_artifact limit 1;

  select tts_audio_artifact_id into v_artifact_id
    from app_private.get_overlay_events('00000000-0000-4000-8000-00000000b031', null, null, 50)
   where event_id = '00000000-0000-0000-0000-00000000b041';
  if v_artifact_id is null then raise exception 'expected an artifact id for the event with stored TTS audio'; end if;
  if v_artifact_id <> v_expected_artifact_id then raise exception 'artifact id % did not match the stored artifact %', v_artifact_id, v_expected_artifact_id; end if;

  select tts_audio_artifact_id into v_artifact_id
    from app_private.get_overlay_events('00000000-0000-4000-8000-00000000b031', null, null, 50)
   where event_id = '00000000-0000-0000-0000-00000000b043';
  if v_artifact_id is not null then raise exception 'expected a null artifact id for the event with no stored TTS audio, got %', v_artifact_id; end if;

  select count(*) into v_row_count from app_private.get_overlay_events('00000000-0000-4000-8000-00000000b031', null, null, 50)
   where event_id = '00000000-0000-0000-0000-00000000b045';
  if v_row_count <> 0 then raise exception 'a delivery on a paused queue must never appear'; end if;

  select count(*) into v_row_count from app_private.get_overlay_events('00000000-0000-4000-8000-00000000b031', null, null, 50)
   where event_id = '00000000-0000-0000-0000-00000000b047';
  if v_row_count <> 0 then raise exception 'a delivery on a closed queue must never appear'; end if;

  select count(*) into v_row_count from app_private.get_overlay_events('00000000-0000-4000-8000-00000000b031', null, null, 50)
   where event_id = '00000000-0000-0000-0000-00000000b049';
  if v_row_count <> 0 then raise exception 'a suppressed (dispatch_allowed = false) delivery must never appear'; end if;

  select count(*) into v_row_count from app_private.get_overlay_events('00000000-0000-4000-8000-00000000b031', null, null, 50)
   where event_id = '00000000-0000-0000-0000-00000000b04b';
  if v_row_count <> 0 then raise exception 'a cancelled (tts_cancelled) delivery must never appear'; end if;

  select count(*) into v_row_count from app_private.get_overlay_events('00000000-0000-4000-8000-00000000b031', null, null, 50)
   where event_id = '00000000-0000-0000-0000-00000000b04d';
  if v_row_count <> 0 then raise exception 'channel A''s session must never see channel B''s delivery'; end if;
end
$$;
commit;

-- Channel scoping, the other direction: channel B's session sees only its
-- own delivery, with its own resolved artifact id.
begin;
set local role bsa_app;
select set_config('app.overlay_session_id', '00000000-0000-4000-8000-00000000b034', true);
do $$
declare
  v_artifact_id uuid;
  v_row_count integer;
begin
  select count(*) into v_row_count from app_private.get_overlay_events('00000000-0000-4000-8000-00000000b034', null, null, 50);
  if v_row_count <> 1 then raise exception 'channel B''s session should see exactly its own one delivery, saw %', v_row_count; end if;

  select tts_audio_artifact_id into v_artifact_id
    from app_private.get_overlay_events('00000000-0000-4000-8000-00000000b034', null, null, 50)
   where event_id = '00000000-0000-0000-0000-00000000b04d';
  if v_artifact_id is null then raise exception 'channel B''s own delivery should resolve its own artifact id'; end if;
end
$$;
commit;

-- Revoked and expired sessions: the function must return nothing at all,
-- exactly as before 0127 -- unchanged by moving ttsAudioUrl out of payload.
begin;
set local role bsa_app;
select set_config('app.overlay_session_id', '00000000-0000-4000-8000-00000000b032', true);
do $$
declare
  v_row_count integer;
begin
  select count(*) into v_row_count from app_private.get_overlay_events('00000000-0000-4000-8000-00000000b032', null, null, 50);
  if v_row_count <> 0 then raise exception 'a revoked overlay session must never receive events, saw %', v_row_count; end if;
end
$$;
commit;

begin;
set local role bsa_app;
select set_config('app.overlay_session_id', '00000000-0000-4000-8000-00000000b033', true);
do $$
declare
  v_row_count integer;
begin
  select count(*) into v_row_count from app_private.get_overlay_events('00000000-0000-4000-8000-00000000b033', null, null, 50);
  if v_row_count <> 0 then raise exception 'an expired overlay session must never receive events, saw %', v_row_count; end if;
end
$$;
commit;

-- Muted queue: the resolved artifact id is null even though the artifact
-- row exists (0101 behaviour; the check moved from the jsonb URL to this
-- column, but the outcome is identical).
do $$
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-00000000b001', true);
  perform app_private.set_companion_tts_mute(
    '00000000-0000-4000-8000-00000000b011'::uuid, '00000000-0000-4000-8000-00000000b001'::uuid,
    '00000000-0000-4000-8000-00000000b021'::uuid, true
  );
end
$$;

begin;
set local role bsa_app;
select set_config('app.overlay_session_id', '00000000-0000-4000-8000-00000000b031', true);
do $$
declare
  v_artifact_id uuid;
  v_row_count integer;
begin
  select tts_audio_artifact_id into v_artifact_id
    from app_private.get_overlay_events('00000000-0000-4000-8000-00000000b031', null, null, 50)
   where event_id = '00000000-0000-0000-0000-00000000b041';
  if v_artifact_id is not null then raise exception 'a muted queue must still yield a null artifact id, got %', v_artifact_id; end if;

  -- The alert itself (visual) must still be present -- mute is audio-only.
  select count(*) into v_row_count from app_private.get_overlay_events('00000000-0000-4000-8000-00000000b031', null, null, 50)
   where event_id = '00000000-0000-0000-0000-00000000b041';
  if v_row_count = 0 then raise exception 'muting suppressed the whole alert delivery, not just the artifact id'; end if;
end
$$;
commit;

select 'RT02_OVERLAY_EVENTS_ARTIFACT_COLUMN=PASS' as result;
