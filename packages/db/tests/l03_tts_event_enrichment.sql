-- L03 acceptance: an eligible alert can be enriched after durable event
-- creation, the artifact is linked append-only to the event, and the event
-- payload carries only the opaque artifact reference used by overlay replay.

begin;
set local role postgres;
insert into channel_configs (channel_id, version, values, effective_at, created_at)
values (
  '00000000-0000-4000-8000-000000000011', 99,
  '{"locale":"hi-IN","tts":{"enabled":true,"voiceId":"bulbul:v1"},"brackets":[{"amountMinPaise":1000,"amountMaxPaise":null,"ttsEligible":true}]}'::jsonb,
  current_timestamp, current_timestamp
);
insert into alert_events (
  id, channel_id, payment_id, source_type, source_id, trace_id,
  config_snapshot_version, payload, created_at
)
values (
  '00000000-0000-0000-0000-0000000002f1',
  '00000000-0000-4000-8000-000000000011', null, 'manual', 'tts-test',
  'tts-enrichment-test', 99, '{"message":"Namaste","amountPaise":"5000"}'::jsonb,
  current_timestamp
);

set local role bsa_app;
do $$
declare
  input_event uuid;
  input_message text;
  input_locale text;
  input_enabled boolean;
  input_eligible boolean;
  artifact_id uuid;
begin
  select event_id, message, locale, enabled, eligible
    into input_event, input_message, input_locale, input_enabled, input_eligible
    from app_private.get_alert_tts_input('00000000-0000-0000-0000-0000000002f1');
  if input_event <> '00000000-0000-0000-0000-0000000002f1'
     or input_message <> 'Namaste' or input_locale <> 'hi-IN'
     or not input_enabled or not input_eligible then
    raise exception 'eligible TTS input was not resolved: %, %, %, %, %', input_event, input_message, input_locale, input_enabled, input_eligible;
  end if;

  artifact_id := app_private.store_alert_tts_audio(
    '00000000-0000-0000-0000-0000000002f1', decode('UklGRg==', 'base64'),
    'audio/wav', 850, 'tts-cache-test-1'
  );
  if artifact_id is null then raise exception 'TTS artifact id was empty'; end if;

  perform app_private.put_alert_tts_cache(
    repeat('a', 64), decode('UklGRg==', 'base64'), 'audio/wav', 850
  );
  if (select count(*) from app_private.get_alert_tts_cache(repeat('a', 64))) <> 1 then
    raise exception 'TTS cache entry was not readable after write';
  end if;
end
$$;

reset role;
set local role postgres;
do $$
begin
  if (select payload ->> 'ttsAudioArtifactId'
        from alert_events
       where id = '00000000-0000-0000-0000-0000000002f1') is null
     or (select count(*) from alert_tts_audio
          where event_id = '00000000-0000-0000-0000-0000000002f1') <> 1 then
    raise exception 'TTS artifact was not durably linked to the alert event';
  end if;
end
$$;
rollback;

select 'L03_TTS_EVENT_ENRICHMENT=PASS' as result;
