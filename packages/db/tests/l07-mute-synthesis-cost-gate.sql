-- L07 follow-up (0103): proves get_alert_tts_input's eligibility now folds
-- in "does any fan-out queue for this event still want TTS" -- the cost
-- gate that stops paid synthesis (and quota consumption, enforced one
-- layer up in apps/api/src/routes/tts.ts, not this database) for an event
-- whose every fan-out queue is muted. Distinct from l07-mute-tts-enforcement
-- .sql (0101), which proves PLAYBACK is silenced for a muted queue without
-- touching a sibling queue -- this file proves SYNTHESIS ELIGIBILITY itself,
-- one layer earlier in the pipeline. Synthetic ids only, own range
-- 00000000-...-00000000b0xx, distinct from every other test file's range.

\set ON_ERROR_STOP on

insert into app_users (id, external_subject, display_name, created_at, updated_at)
values ('00000000-0000-4000-8000-00000000b001', 'google-l07synth-owner', 'Synthetic L07 Synthesis Owner', current_timestamp, current_timestamp)
on conflict (id) do nothing;

begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-00000000b001', true);
select * from app_private.create_channel(
  '00000000-0000-4000-8000-00000000b011',
  '00000000-0000-4000-8000-00000000b001', 'l07synth_channel', 'L07 Synthesis Cost Gate Test Channel'
);
commit;

update channel_entitlement_versions
   set tier = 'creator', values = values || jsonb_build_object('ttsEnabled', true, 'maxCharLimit', 250)
 where channel_id = '00000000-0000-4000-8000-00000000b011';

update channel_configs
   set values = '{"locale":"en-IN","tts":{"enabled":true},"brackets":[{"amountMinPaise":1000,"amountMaxPaise":null,"ttsEligible":true,"charLimit":250}]}'::jsonb
 where channel_id = '00000000-0000-4000-8000-00000000b011' and version = 1;

insert into alert_queues (id, channel_id, name, created_at, updated_at)
values
  ('00000000-0000-4000-8000-00000000b021', '00000000-0000-4000-8000-00000000b011', 'Queue A', current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-00000000b022', '00000000-0000-4000-8000-00000000b011', 'Queue B', current_timestamp, current_timestamp);

-- -----------------------------------------------------------------------
-- Case 1: no queues muted -> eligible = true (unchanged from today).
-- -----------------------------------------------------------------------
begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-00000000b001', true);
select * from app_private.create_manual_alert(
  '00000000-0000-0000-0000-00000000b041', '00000000-0000-0000-0000-00000000b042',
  '00000000-0000-4000-8000-00000000b011', '00000000-0000-4000-8000-00000000b001',
  'trace-l07-synth-none-muted', 1,
  jsonb_build_object('displayName', 'Viewer', 'message', 'no mute here', 'amountPaise', '20000',
    'queueIds', jsonb_build_array('00000000-0000-4000-8000-00000000b021', '00000000-0000-4000-8000-00000000b022'))
);
commit;

do $$
declare
  is_eligible boolean;
begin
  select eligible into is_eligible from app_private.get_alert_tts_input('00000000-0000-0000-0000-00000000b041'::uuid);
  if is_eligible is distinct from true then
    raise exception 'no queues muted: expected eligible=true, got %', is_eligible;
  end if;
end
$$;

-- -----------------------------------------------------------------------
-- Case 2: mute BOTH fan-out queues before the event exists -> eligible =
-- false. This is the actual bug fix: no synthesis, no quota, for an event
-- nobody could ever hear.
-- -----------------------------------------------------------------------
do $$
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-00000000b001', true);
  perform app_private.set_companion_tts_mute(
    '00000000-0000-4000-8000-00000000b011'::uuid, '00000000-0000-4000-8000-00000000b001'::uuid,
    '00000000-0000-4000-8000-00000000b021'::uuid, true
  );
  perform app_private.set_companion_tts_mute(
    '00000000-0000-4000-8000-00000000b011'::uuid, '00000000-0000-4000-8000-00000000b001'::uuid,
    '00000000-0000-4000-8000-00000000b022'::uuid, true
  );
end
$$;

begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-00000000b001', true);
select * from app_private.create_manual_alert(
  '00000000-0000-0000-0000-00000000b043', '00000000-0000-0000-0000-00000000b044',
  '00000000-0000-4000-8000-00000000b011', '00000000-0000-4000-8000-00000000b001',
  'trace-l07-synth-all-muted', 1,
  jsonb_build_object('displayName', 'Viewer', 'message', 'both muted', 'amountPaise', '20000',
    'queueIds', jsonb_build_array('00000000-0000-4000-8000-00000000b021', '00000000-0000-4000-8000-00000000b022'))
);
commit;

do $$
declare
  is_eligible boolean;
  row_count integer;
begin
  select count(*) into row_count from app_private.get_alert_tts_input('00000000-0000-0000-0000-00000000b043'::uuid);
  select eligible into is_eligible from app_private.get_alert_tts_input('00000000-0000-0000-0000-00000000b043'::uuid);
  if row_count <> 1 then raise exception 'all queues muted: expected exactly one input row, got %', row_count; end if;
  if is_eligible is distinct from false then
    raise exception 'all fan-out queues muted: expected eligible=false, got %', is_eligible;
  end if;
end
$$;

-- The visual alert must still fire regardless of the synthesis cost gate
-- above -- eligibility only governs whether apps/api's tts.ts route calls
-- the paid provider, never whether get_overlay_events returns the alert
-- row itself (0101 already proved that in l07-mute-tts-enforcement.sql;
-- re-asserted here scoped to this file's own fixtures for isolation).
insert into overlay_sessions (id, channel_id, token_fingerprint, expires_at, created_at)
values ('00000000-0000-4000-8000-00000000b031', '00000000-0000-4000-8000-00000000b011', 'fingerprint-l07-synth', current_timestamp + interval '1 hour', current_timestamp);

begin;
set local role bsa_app;
select set_config('app.overlay_session_id', '00000000-0000-4000-8000-00000000b031', true);
do $$
declare
  visual_row_exists boolean;
begin
  select (count(*) > 0) into visual_row_exists
    from app_private.get_overlay_events('00000000-0000-4000-8000-00000000b031', null, null, 50)
   where event_id = '00000000-0000-0000-0000-00000000b043';
  if not visual_row_exists then
    raise exception 'all-muted event was suppressed visually too -- the cost gate must be synthesis-only';
  end if;
end
$$;
commit;

-- -----------------------------------------------------------------------
-- Case 3: unmute ONE of the two queues -> eligible = true again (a single
-- unmuted target is enough to justify paying for synthesis once, shared
-- by both deliveries as production already does).
-- -----------------------------------------------------------------------
do $$
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-00000000b001', true);
  perform app_private.set_companion_tts_mute(
    '00000000-0000-4000-8000-00000000b011'::uuid, '00000000-0000-4000-8000-00000000b001'::uuid,
    '00000000-0000-4000-8000-00000000b022'::uuid, false
  );
end
$$;

begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-00000000b001', true);
select * from app_private.create_manual_alert(
  '00000000-0000-0000-0000-00000000b045', '00000000-0000-0000-0000-00000000b046',
  '00000000-0000-4000-8000-00000000b011', '00000000-0000-4000-8000-00000000b001',
  'trace-l07-synth-partial-mute', 1,
  jsonb_build_object('displayName', 'Viewer', 'message', 'one still listening', 'amountPaise', '20000',
    'queueIds', jsonb_build_array('00000000-0000-4000-8000-00000000b021', '00000000-0000-4000-8000-00000000b022'))
);
commit;

do $$
declare
  is_eligible boolean;
begin
  select eligible into is_eligible from app_private.get_alert_tts_input('00000000-0000-0000-0000-00000000b045'::uuid);
  if is_eligible is distinct from true then
    raise exception 'one queue unmuted (of two): expected eligible=true, got %', is_eligible;
  end if;
end
$$;

-- Synthesize once, as production does after eligible=true, then prove the
-- still-muted queue's delivery gets no audio while the unmuted sibling
-- does -- one synthesis, split correctly at playback (0101), never
-- silenced at synthesis time by the other queue's mute.
do $$
begin
  perform app_private.store_alert_tts_audio(
    '00000000-0000-0000-0000-00000000b045'::uuid,
    decode(repeat('00', 100), 'hex'), 'audio/wav', 1500, 'cache-key-l07-synth-partial'
  );
end
$$;

begin;
set local role bsa_app;
select set_config('app.overlay_session_id', '00000000-0000-4000-8000-00000000b031', true);
do $$
declare
  muted_url text;
  unmuted_url text;
begin
  select payload ->> 'ttsAudioUrl' into muted_url
    from app_private.get_overlay_events('00000000-0000-4000-8000-00000000b031', null, null, 50)
   where event_id = '00000000-0000-0000-0000-00000000b045' and (payload ->> 'queueId')::uuid = '00000000-0000-4000-8000-00000000b021';
  select payload ->> 'ttsAudioUrl' into unmuted_url
    from app_private.get_overlay_events('00000000-0000-4000-8000-00000000b031', null, null, 50)
   where event_id = '00000000-0000-0000-0000-00000000b045' and (payload ->> 'queueId')::uuid = '00000000-0000-4000-8000-00000000b022';
  if muted_url is not null then raise exception 'still-muted queue B021 unexpectedly carried a ttsAudioUrl: %', muted_url; end if;
  if unmuted_url is null then raise exception 'unmuted queue B022 unexpectedly had no ttsAudioUrl'; end if;
end
$$;
commit;

select 'L07_MUTE_SYNTHESIS_COST_GATE=PASS' as result;
