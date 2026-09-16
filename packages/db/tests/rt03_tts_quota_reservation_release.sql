-- RT-03.6 acceptance (blocking): app_private.release_tts_usage_reservation
-- gives back exactly what a prior app_private.meter_tts_usage reservation
-- charged, on every failure class, never goes negative, and never
-- manufactures quota that was not reserved. Synthetic identifiers only;
-- never touches production data.
--
-- Rewritten 2026-09-16 for migration 0134 (release by reservation id).
-- The previous version of this file asserted that a double release was a
-- safe no-op AND PASSED -- but only because it released a month whose
-- counter had already reached 0, where greatest(...,0) floored the second
-- subtraction. It never tested a double release against a month holding
-- OTHER usage, which is the arrangement where 0128's missing idempotency
-- actually manufactured quota. Both that case and the billing-month
-- rollover case are now covered below.

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
  ('00000000-0000-0000-0000-0000f0030603', '00000000-0000-4000-8000-0000f0030011', null, 'manual', 'rt03-release-3', 'rt03-release-3', 1, '{"message":"hi"}'::jsonb, current_timestamp),
  ('00000000-0000-0000-0000-0000f0030604', '00000000-0000-4000-8000-0000f0030011', null, 'manual', 'rt03-release-4', 'rt03-release-4', 1, '{"message":"hi"}'::jsonb, current_timestamp);

set local role bsa_app;
do $$
declare
  allowed boolean;
  remaining integer;
  reason text;
  reservation uuid;
  other_reservation uuid;
  remaining_row record;
  last_month date := (date_trunc('month', current_timestamp) - interval '1 month')::date;
  rolled_reservation uuid := '00000000-0000-4000-8000-0000f0030901';
begin
  -- Reserve (meter) 500 characters against the pro quota (20000).
  select * into allowed, remaining, reason, reservation
    from app_private.meter_tts_usage('00000000-0000-0000-0000-0000f0030601', 500);
  if not allowed or remaining <> 19500 then
    raise exception 'reservation did not settle the expected charge: allowed=%, remaining=%', allowed, remaining;
  end if;
  if reservation is null then
    raise exception 'an allowed meter must return a reservation id to release against';
  end if;

  select * into remaining_row from app_private.get_tts_quota_remaining('00000000-0000-4000-8000-0000f0030011');
  if remaining_row.characters_used <> 500 then
    raise exception 'reservation was not reflected in characters_used: %', remaining_row;
  end if;

  -- RT-03.6: releasing that reservation restores the balance exactly -- a
  -- failed synthesis must not consume premium characters.
  perform app_private.release_tts_usage_reservation(reservation);

  select * into remaining_row from app_private.get_tts_quota_remaining('00000000-0000-4000-8000-0000f0030011');
  if remaining_row.characters_used <> 0 or remaining_row.remaining <> 20000 then
    raise exception 'release did not restore the balance to its pre-reservation state: %', remaining_row;
  end if;

  -- THE CASE THE OLD TEST COULD NOT SEE. Hold a second, still-unreleased
  -- reservation so the month's counter is NOT zero, then release the
  -- already-released first reservation again. Under 0128 this subtracted a
  -- second time and handed the creator 500 characters nobody reserved --
  -- the greatest(...,0) floor never engaged, because 300 - 500 is only
  -- clamped when the result would go negative, and here it simply ate the
  -- other reservation's charge. Idempotency must now hold on its own.
  select * into allowed, remaining, reason, other_reservation
    from app_private.meter_tts_usage('00000000-0000-0000-0000-0000f0030602', 300);
  if not allowed or remaining <> 19700 then
    raise exception 'second reservation did not settle correctly: allowed=%, remaining=%', allowed, remaining;
  end if;

  perform app_private.release_tts_usage_reservation(reservation);

  select * into remaining_row from app_private.get_tts_quota_remaining('00000000-0000-4000-8000-0000f0030011');
  if remaining_row.characters_used <> 300 then
    raise exception 'double release manufactured quota against a month holding other usage: %', remaining_row;
  end if;

  -- And the still-open reservation is unaffected by that duplicate: it can
  -- still be released exactly once, for exactly its own charge.
  perform app_private.release_tts_usage_reservation(other_reservation);
  select * into remaining_row from app_private.get_tts_quota_remaining('00000000-0000-4000-8000-0000f0030011');
  if remaining_row.characters_used <> 0 or remaining_row.remaining <> 20000 then
    raise exception 'the untouched reservation did not release cleanly after a duplicate release: %', remaining_row;
  end if;

  -- BILLING-MONTH ROLLOVER. A reservation charged to last month, released
  -- now. 0128 credited date_trunc('month', current_timestamp) -- THIS month
  -- -- so the old month kept the charge and this month was credited
  -- characters it never reserved. The release must land on the month the
  -- reservation names. Built directly rather than by waiting for a month
  -- boundary: the reservation row is the only thing that carries the month,
  -- so setting it is a faithful reproduction, not an approximation.
  insert into public.alert_tts_usage_monthly (channel_id, billing_month, characters_used, updated_at)
  values ('00000000-0000-4000-8000-0000f0030011', last_month, 400, current_timestamp);
  insert into public.alert_tts_usage_reservations (id, event_id, channel_id, billing_month, characters, reserved_at)
  values (rolled_reservation, '00000000-0000-0000-0000-0000f0030604', '00000000-0000-4000-8000-0000f0030011', last_month, 400, current_timestamp);

  -- Give the CURRENT month some usage, so a release that lands on the wrong
  -- month would visibly corrupt it rather than being floored to zero.
  select * into allowed, remaining, reason, other_reservation
    from app_private.meter_tts_usage('00000000-0000-0000-0000-0000f0030603', 250);
  if not allowed then
    raise exception 'current-month reservation was refused: %', reason;
  end if;

  perform app_private.release_tts_usage_reservation(rolled_reservation);

  select * into remaining_row from app_private.get_tts_quota_remaining('00000000-0000-4000-8000-0000f0030011');
  if remaining_row.characters_used <> 250 then
    raise exception 'a release for last month was credited to this month: %', remaining_row;
  end if;
  if (select characters_used from public.alert_tts_usage_monthly
       where channel_id = '00000000-0000-4000-8000-0000f0030011' and billing_month = last_month) <> 0 then
    raise exception 'a release for last month did not credit last month';
  end if;

  -- Clean up the remaining open reservation.
  perform app_private.release_tts_usage_reservation(other_reservation);

  -- A null reservation id is a safe no-op: the meter charged nothing (a
  -- zero-character message), so there is nothing to give back.
  perform app_private.release_tts_usage_reservation(null);
  select * into remaining_row from app_private.get_tts_quota_remaining('00000000-0000-4000-8000-0000f0030011');
  if remaining_row.characters_used <> 0 then
    raise exception 'a null-reservation release changed the balance: %', remaining_row;
  end if;

  -- A zero-character meter writes no reservation at all, precisely so that
  -- no zero-character row can exist to be released.
  select * into allowed, remaining, reason, other_reservation
    from app_private.meter_tts_usage('00000000-0000-0000-0000-0000f0030603', 0);
  if not allowed or other_reservation is not null then
    raise exception 'a zero-character meter must charge nothing and reserve nothing: id=%', other_reservation;
  end if;

  -- A negative character count is still rejected, matching meter_tts_usage's
  -- own fail-closed shape for an invalid count.
  begin
    perform app_private.meter_tts_usage('00000000-0000-0000-0000-0000f0030603', -1);
    raise exception 'negative character count was not rejected';
  exception when sqlstate '22023' then
    null;
  end;

  -- An unknown reservation id raises rather than silently releasing against
  -- nothing -- the same fail-closed posture meter_tts_usage takes for an
  -- unknown event.
  begin
    perform app_private.release_tts_usage_reservation('00000000-0000-0000-0000-00000000ffff');
    raise exception 'releasing an unknown reservation id did not raise';
  exception when sqlstate '23503' then
    null;
  end;
end
$$;

-- The application role must never reach the reservation ledger directly --
-- it exists only behind the two security-definer functions above.
do $$
begin
  set local role bsa_app;
  begin
    perform 1 from public.alert_tts_usage_reservations limit 1;
    raise exception 'bsa_app could read alert_tts_usage_reservations directly';
  exception when insufficient_privilege then
    null;
  end;
end
$$;
