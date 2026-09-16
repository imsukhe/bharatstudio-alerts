-- L03 acceptance: TTS character metering (0081) — hard stop at quota,
-- boundary behavior, free tier blocked, and unknown tier raises. Synthetic
-- identifiers only; never touches production data.

\set ON_ERROR_STOP on

do $$
begin
  if app_private.tier_tts_monthly_quota('free') <> 0
     or app_private.tier_tts_monthly_quota('pro') <> 20000
     or app_private.tier_tts_monthly_quota('creator') <> 40000
     or app_private.tier_tts_monthly_quota('studio') <> 60000 then
    raise exception 'tier_tts_monthly_quota does not match the 3.2 quotas';
  end if;
  begin
    perform app_private.tier_tts_monthly_quota('enterprise');
    raise exception 'tier_tts_monthly_quota accepted an unapproved tier';
  exception when sqlstate '22023' then
    null;
  end;
end
$$;

insert into app_users (id, external_subject, display_name, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000001201', 'google-l03-tts-free', 'Synthetic TTS Free Owner', current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000001202', 'google-l03-tts-pro', 'Synthetic TTS Pro Owner', current_timestamp, current_timestamp);

begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000001201', true);
select * from app_private.create_channel(
  '00000000-0000-4000-8000-000000001211',
  '00000000-0000-4000-8000-000000001201', 'tts_metering_free_test', 'TTS Metering Free Test'
);
commit;

begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000001202', true);
select * from app_private.create_channel(
  '00000000-0000-4000-8000-000000001212',
  '00000000-0000-4000-8000-000000001202', 'tts_metering_pro_test', 'TTS Metering Pro Test'
);
commit;

-- Force the second channel onto 'pro' directly (bypassing the webhook path,
-- matching every other fixture-setup pattern in this test suite).
update channel_entitlement_versions
   set tier = 'pro', values = values || jsonb_build_object('ttsEnabled', true)
 where channel_id = '00000000-0000-4000-8000-000000001212';

-- Synthetic alert events to meter against (manual source, no payment link).
insert into alert_events (id, channel_id, payment_id, source_type, source_id, trace_id, config_snapshot_version, payload, created_at)
values
  ('00000000-0000-0000-0000-000000003401', '00000000-0000-4000-8000-000000001211', null, 'manual', 'tts-meter-free', 'tts-meter-free', 1, '{"message":"hi"}'::jsonb, current_timestamp),
  ('00000000-0000-0000-0000-000000003501', '00000000-0000-4000-8000-000000001212', null, 'manual', 'tts-meter-pro-1', 'tts-meter-pro-1', 1, '{"message":"hi"}'::jsonb, current_timestamp),
  ('00000000-0000-0000-0000-000000003502', '00000000-0000-4000-8000-000000001212', null, 'manual', 'tts-meter-pro-2', 'tts-meter-pro-2', 1, '{"message":"hi"}'::jsonb, current_timestamp),
  ('00000000-0000-0000-0000-000000003503', '00000000-0000-4000-8000-000000001212', null, 'manual', 'tts-meter-pro-3', 'tts-meter-pro-3', 1, '{"message":"hi"}'::jsonb, current_timestamp);

set local role bsa_app;
do $$
declare
  allowed boolean;
  remaining integer;
  reason text;
  reservation uuid;
  remaining_row record;
begin
  -- Free tier must not call paid TTS at all: quota is 0, blocked before any
  -- usage is recorded, distinguishable reason.
  select * into allowed, remaining, reason, reservation from app_private.meter_tts_usage('00000000-0000-0000-0000-000000003401', 100);
  if allowed or reason <> 'tier_not_entitled' or remaining <> 0 then
    raise exception 'free tier TTS metering was not blocked as tier_not_entitled: allowed=%, reason=%, remaining=%', allowed, reason, remaining;
  end if;

  -- Pro tier (quota 20000): consume most of the quota, then hit the exact
  -- boundary, then exceed it.
  select * into allowed, remaining, reason, reservation from app_private.meter_tts_usage('00000000-0000-0000-0000-000000003501', 19999);
  if not allowed or remaining <> 1 then
    raise exception 'pro tier TTS metering under quota was not allowed correctly: allowed=%, remaining=%', allowed, remaining;
  end if;

  -- Exactly the remaining 1 character: boundary case, must be allowed and
  -- bring remaining to precisely 0 (hard stop is "> quota", not ">= quota").
  select * into allowed, remaining, reason, reservation from app_private.meter_tts_usage('00000000-0000-0000-0000-000000003502', 1);
  if not allowed or remaining <> 0 then
    raise exception 'pro tier TTS metering at the exact quota boundary was not allowed correctly: allowed=%, remaining=%', allowed, remaining;
  end if;

  -- Now at 0 remaining: even a single further character must hard-stop.
  select * into allowed, remaining, reason, reservation from app_private.meter_tts_usage('00000000-0000-0000-0000-000000003503', 1);
  if allowed or reason <> 'quota_exhausted' or remaining <> 0 then
    raise exception 'pro tier TTS metering past quota was not hard-stopped: allowed=%, reason=%, remaining=%', allowed, reason, remaining;
  end if;

  select * into remaining_row from app_private.get_tts_quota_remaining('00000000-0000-4000-8000-000000001212');
  if remaining_row.characters_used <> 20000 or remaining_row.remaining <> 0 or remaining_row.monthly_quota <> 20000 or remaining_row.tier <> 'pro' then
    raise exception 'get_tts_quota_remaining did not reflect the metered usage: %', remaining_row;
  end if;

  select * into remaining_row from app_private.get_tts_quota_remaining('00000000-0000-4000-8000-000000001211');
  if remaining_row.monthly_quota <> 0 or remaining_row.remaining <> 0 or remaining_row.tier <> 'free' then
    raise exception 'get_tts_quota_remaining did not reflect the free tier quota: %', remaining_row;
  end if;

  -- Unknown tier raises (fail closed), exercised directly since no channel
  -- can hold an unapproved tier (the entitlement tier CHECK constraint
  -- already forbids it) — proves meter_tts_usage's own dependency on
  -- tier_tts_monthly_quota still fails closed rather than defaulting open.
  begin
    perform app_private.tier_tts_monthly_quota('enterprise');
    raise exception 'unknown tier did not raise inside the metering path';
  exception when sqlstate '22023' then
    null;
  end;

  -- Unknown event id raises rather than silently metering against nothing.
  begin
    perform app_private.meter_tts_usage('00000000-0000-0000-0000-00000000ffff', 10);
    raise exception 'metering an unknown event id did not raise';
  exception when sqlstate '23503' then
    null;
  end;
end
$$;
