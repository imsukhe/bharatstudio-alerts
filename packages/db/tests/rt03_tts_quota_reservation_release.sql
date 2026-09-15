-- RT-03.6 acceptance (blocking): app_private.release_tts_usage_reservation
-- (0128) gives back exactly what a prior app_private.meter_tts_usage (0081)
-- reservation charged, on every failure class, never goes negative, and
-- never manufactures quota that was not reserved. Synthetic identifiers
-- only; never touches production data.

\set ON_ERROR_STOP on

insert into app_users (id, external_subject, display_name, created_at, updated_at)
values
  ('00000000-0000-4000-8000-0000f0030001', 'google-rt03-tts-pro', 'Synthetic RT-03 Pro Owner', current_timestamp, current_timestamp);

begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-0000f0030001', true);
select * from app_private.create_channel(
  '00000000-0000-4000-8000-0000f0030011',
  '00000000-0000-4000-8000-0000f0030001', 'rt03_tts_release_test', 'RT-03 TTS Release Test'
);
commit;

update channel_entitlement_versions
   set tier = 'pro', values = values || jsonb_build_object('ttsEnabled', true)
 where channel_id = '00000000-0000-4000-8000-0000f0030011';

insert into alert_events (id, channel_id, payment_id, source_type, source_id, trace_id, config_snapshot_version, payload, created_at)
values
  ('00000000-0000-0000-0000-0000f0030601', '00000000-0000-4000-8000-0000f0030011', null, 'manual', 'rt03-release-1', 'rt03-release-1', 1, '{"message":"hi"}'::jsonb, current_timestamp),
  ('00000000-0000-0000-0000-0000f0030602', '00000000-0000-4000-8000-0000f0030011', null, 'manual', 'rt03-release-2', 'rt03-release-2', 1, '{"message":"hi"}'::jsonb, current_timestamp),
  ('00000000-0000-0000-0000-0000f0030603', '00000000-0000-4000-8000-0000f0030011', null, 'manual', 'rt03-release-3', 'rt03-release-3', 1, '{"message":"hi"}'::jsonb, current_timestamp);

set local role bsa_app;
do $$
declare
  allowed boolean;
  remaining integer;
  reason text;
  remaining_row record;
begin
  -- Reserve (meter) 500 characters against the pro quota (20000).
  select * into allowed, remaining, reason from app_private.meter_tts_usage('00000000-0000-0000-0000-0000f0030601', 500);
  if not allowed or remaining <> 19500 then
    raise exception 'reservation did not settle the expected charge: allowed=%, remaining=%', allowed, remaining;
  end if;

  select * into remaining_row from app_private.get_tts_quota_remaining('00000000-0000-4000-8000-0000f0030011');
  if remaining_row.characters_used <> 500 then
    raise exception 'reservation was not reflected in characters_used: %', remaining_row;
  end if;

  -- RT-03.6: releasing the same reservation restores the balance exactly --
  -- a failed synthesis must not consume premium characters.
  perform app_private.release_tts_usage_reservation('00000000-0000-0000-0000-0000f0030601', 500);

  select * into remaining_row from app_private.get_tts_quota_remaining('00000000-0000-4000-8000-0000f0030011');
  if remaining_row.characters_used <> 0 or remaining_row.remaining <> 20000 then
    raise exception 'release did not restore the balance to its pre-reservation state: %', remaining_row;
  end if;

  -- A second release of the same, already-released reservation is a safe
  -- no-op: it must not go negative and must not manufacture quota.
  perform app_private.release_tts_usage_reservation('00000000-0000-0000-0000-0000f0030601', 500);

  select * into remaining_row from app_private.get_tts_quota_remaining('00000000-0000-4000-8000-0000f0030011');
  if remaining_row.characters_used <> 0 or remaining_row.remaining <> 20000 then
    raise exception 'double release manufactured or destroyed quota: %', remaining_row;
  end if;

  -- A partial release (release less than was reserved) leaves the
  -- remainder charged -- release gives back exactly what it is asked to,
  -- never the whole reservation implicitly.
  select * into allowed, remaining, reason from app_private.meter_tts_usage('00000000-0000-0000-0000-0000f0030602', 300);
  if not allowed or remaining <> 19700 then
    raise exception 'second reservation did not settle correctly: allowed=%, remaining=%', allowed, remaining;
  end if;
  perform app_private.release_tts_usage_reservation('00000000-0000-0000-0000-0000f0030602', 100);
  select * into remaining_row from app_private.get_tts_quota_remaining('00000000-0000-4000-8000-0000f0030011');
  if remaining_row.characters_used <> 200 or remaining_row.remaining <> 19800 then
    raise exception 'partial release did not leave the correct remainder charged: %', remaining_row;
  end if;
  -- Clean up the remainder so the next case starts from a known baseline.
  perform app_private.release_tts_usage_reservation('00000000-0000-0000-0000-0000f0030602', 200);

  -- Zero-character release is a safe no-op (nothing was ever reserved).
  perform app_private.release_tts_usage_reservation('00000000-0000-0000-0000-0000f0030603', 0);
  select * into remaining_row from app_private.get_tts_quota_remaining('00000000-0000-4000-8000-0000f0030011');
  if remaining_row.characters_used <> 0 then
    raise exception 'zero-character release changed the balance: %', remaining_row;
  end if;

  -- A negative character count is rejected, matching meter_tts_usage's own
  -- fail-closed shape for an invalid count.
  begin
    perform app_private.release_tts_usage_reservation('00000000-0000-0000-0000-0000f0030603', -1);
    raise exception 'negative character count was not rejected';
  exception when sqlstate '22023' then
    null;
  end;

  -- An unknown event id raises rather than silently releasing against
  -- nothing, matching meter_tts_usage's own behaviour for an unknown event.
  begin
    perform app_private.release_tts_usage_reservation('00000000-0000-0000-0000-00000000ffff', 10);
    raise exception 'releasing against an unknown event id did not raise';
  exception when sqlstate '23503' then
    null;
  end;
end
$$;
