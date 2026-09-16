-- L03 acceptance: MASTER-PLAN §10.3 items 5, 6, 7 (migration 0096).
-- Synthetic identifiers only; own fixture ids 00000000-...-000000001801
-- upward. run-sql-suite.sh gives every test file its own database, so no
-- cross-file id collision is possible even if another file reuses this
-- block.

\set ON_ERROR_STOP on

-- Item 6: the amount ladder is a pure function of amountPaise. Exercise
-- every band boundary directly, including the null-input default.
do $$
begin
  if app_private.tts_amount_char_limit(null) <> 40 then raise exception 'null amount did not default to the smallest band'; end if;
  if app_private.tts_amount_char_limit(0) <> 40 then raise exception 'zero amount was not in the smallest band'; end if;
  if app_private.tts_amount_char_limit(9999) <> 40 then raise exception '9999 paise was not in the smallest band'; end if;
  if app_private.tts_amount_char_limit(10000) <> 80 then raise exception '10000 paise did not enter the second band'; end if;
  if app_private.tts_amount_char_limit(49999) <> 80 then raise exception '49999 paise left the second band early'; end if;
  if app_private.tts_amount_char_limit(50000) <> 150 then raise exception '50000 paise did not enter the third band'; end if;
  if app_private.tts_amount_char_limit(99999) <> 150 then raise exception '99999 paise left the third band early'; end if;
  if app_private.tts_amount_char_limit(100000) <> 250 then raise exception '100000 paise did not enter the fourth band'; end if;
  if app_private.tts_amount_char_limit(499999) <> 250 then raise exception '499999 paise left the fourth band early'; end if;
  if app_private.tts_amount_char_limit(500000) <> 400 then raise exception '500000 paise did not enter the top band'; end if;
  if app_private.tts_amount_char_limit(50000000) <> 400 then raise exception 'a very large tip exceeded the top band'; end if;
end
$$;

-- Two synthetic channels: A stays on the free tier create_channel already
-- assigns; B is retiered to pro directly (bypassing the webhook path,
-- matching every other fixture-setup pattern in this suite).
insert into app_users (id, external_subject, display_name, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000001801', 'google-l03-tts-fb-free', 'Synthetic TTS Fallback Free Owner', current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000001802', 'google-l03-tts-fb-pro', 'Synthetic TTS Fallback Pro Owner', current_timestamp, current_timestamp);

begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000001801', true);
select * from app_private.create_channel(
  '00000000-0000-4000-8000-000000001811',
  '00000000-0000-4000-8000-000000001801', 'tts_fallback_free_test', 'TTS Fallback Free Test'
);
commit;

begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000001802', true);
select * from app_private.create_channel(
  '00000000-0000-4000-8000-000000001812',
  '00000000-0000-4000-8000-000000001802', 'tts_fallback_pro_test', 'TTS Fallback Pro Test'
);
commit;

update channel_entitlement_versions
   set tier = 'pro', values = values || jsonb_build_object('ttsEnabled', true, 'maxCharLimit', 150)
 where channel_id = '00000000-0000-4000-8000-000000001812';

-- TTS on, every amount eligible, for both channels — this is the creator's
-- own config; entitlement/quota is a separate, server-side hard stop.
update channel_configs
   set values = '{"locale":"en-IN","tts":{"enabled":true},"brackets":[{"amountMinPaise":1000,"amountMaxPaise":null,"ttsEligible":true,"charLimit":500}]}'::jsonb
 where channel_id = '00000000-0000-4000-8000-000000001811' and version = 1;
update channel_configs
   set values = '{"locale":"en-IN","tts":{"enabled":true},"brackets":[{"amountMinPaise":1000,"amountMaxPaise":null,"ttsEligible":true,"charLimit":500}]}'::jsonb
 where channel_id = '00000000-0000-4000-8000-000000001812' and version = 1;

-- Item 6 (continued): get_alert_tts_input truncates to LEAST(amount ladder,
-- tier maxCharLimit) — never to either alone.
insert into alert_events (id, channel_id, payment_id, source_type, source_id, trace_id, config_snapshot_version, payload, created_at)
values
  -- Free tier (maxCharLimit=100), amountPaise=20000 -> ladder band 80.
  -- 80 < 100, so the ladder wins.
  ('00000000-0000-0000-0000-000000003801', '00000000-0000-4000-8000-000000001811', null, 'manual', 'ladder-free-mid', 'ladder-free-mid', 1,
   jsonb_build_object('message', repeat('a', 300), 'amountPaise', '20000'), current_timestamp),
  -- Pro tier (maxCharLimit=150), amountPaise=600000 -> ladder band 400.
  -- 150 < 400, so the tier ceiling wins.
  ('00000000-0000-0000-0000-000000003802', '00000000-0000-4000-8000-000000001812', null, 'manual', 'ladder-pro-big-tip', 'ladder-pro-big-tip', 1,
   jsonb_build_object('message', repeat('b', 300), 'amountPaise', '600000'), current_timestamp),
  -- Pro tier, amountPaise=5000 -> ladder band 40 (below the 150 ceiling),
  -- so a tiny tip still only gets 40 characters even on a paid tier.
  ('00000000-0000-0000-0000-000000003803', '00000000-0000-4000-8000-000000001812', null, 'manual', 'ladder-pro-small-tip', 'ladder-pro-small-tip', 1,
   jsonb_build_object('message', repeat('c', 300), 'amountPaise', '5000'), current_timestamp);

set local role bsa_app;
do $$
declare
  input_message text;
begin
  select message into input_message from app_private.get_alert_tts_input('00000000-0000-0000-0000-000000003801');
  if length(input_message) <> 80 then
    raise exception 'free-tier mid-size tip did not truncate to the amount ladder (80): got %', length(input_message);
  end if;

  select message into input_message from app_private.get_alert_tts_input('00000000-0000-0000-0000-000000003802');
  if length(input_message) <> 150 then
    raise exception 'pro-tier big tip did not truncate to the tighter tier maxCharLimit (150): got %', length(input_message);
  end if;

  select message into input_message from app_private.get_alert_tts_input('00000000-0000-0000-0000-000000003803');
  if length(input_message) <> 40 then
    raise exception 'pro-tier tiny tip did not truncate to the tighter amount ladder (40): got %', length(input_message);
  end if;
end
$$;

-- Item 5: store_alert_tts_fallback_reason is the durable write-back the
-- overlay's browser-TTS fallback reads. Only the two entitlement/quota
-- reasons are accepted; anything else, or an unknown event, must fail
-- closed rather than silently writing bad state.
do $$
begin
  perform app_private.store_alert_tts_fallback_reason('00000000-0000-0000-0000-000000003801', 'tier_not_entitled');
  perform app_private.store_alert_tts_fallback_reason('00000000-0000-0000-0000-000000003802', 'quota_exhausted');

  begin
    perform app_private.store_alert_tts_fallback_reason('00000000-0000-0000-0000-000000003801', 'not_a_real_reason');
    raise exception 'an invalid TTS fallback reason was accepted';
  exception when sqlstate '22023' then
    null;
  end;

  begin
    perform app_private.store_alert_tts_fallback_reason('00000000-0000-0000-0000-00000000ffff', 'quota_exhausted');
    raise exception 'a TTS fallback reason was recorded against an unknown event id';
  exception when sqlstate '23503' then
    null;
  end;
end
$$;

do $$
begin
  if (select payload ->> 'ttsFallbackReason' from alert_events where id = '00000000-0000-0000-0000-000000003801') <> 'tier_not_entitled' then
    raise exception 'tier_not_entitled fallback reason was not durably recorded';
  end if;
  if (select payload ->> 'ttsFallbackReason' from alert_events where id = '00000000-0000-0000-0000-000000003802') <> 'quota_exhausted' then
    raise exception 'quota_exhausted fallback reason was not durably recorded';
  end if;
  -- Recording a fallback reason must never touch metered usage — a browser
  -- voice fallback can never consume paid quota.
  if exists (select 1 from alert_tts_usage_monthly where channel_id in (
    '00000000-0000-4000-8000-000000001811', '00000000-0000-4000-8000-000000001812'
  )) then
    raise exception 'storing a TTS fallback reason unexpectedly wrote metered usage';
  end if;
end
$$;

-- Item 5 + 7 through the overlay stream: get_overlay_events must expose
-- both the fallback reason and the Free-only watermark flag on the same
-- delivered payload the overlay already reads for ttsAudioUrl.
insert into alert_queues (id, channel_id, name, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000001821', '00000000-0000-4000-8000-000000001811', 'Free overlay queue', current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000001822', '00000000-0000-4000-8000-000000001812', 'Pro overlay queue', current_timestamp, current_timestamp);

insert into overlay_sessions (id, channel_id, token_fingerprint, expires_at, created_at)
values
  ('00000000-0000-4000-8000-000000001831', '00000000-0000-4000-8000-000000001811', 'fingerprint-l03-tts-free', current_timestamp + interval '1 hour', current_timestamp),
  ('00000000-0000-4000-8000-000000001832', '00000000-0000-4000-8000-000000001812', 'fingerprint-l03-tts-pro', current_timestamp + interval '1 hour', current_timestamp);

begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000001801', true);
select * from app_private.create_manual_alert(
  '00000000-0000-0000-0000-000000003811', '00000000-0000-0000-0000-000000003812',
  '00000000-0000-4000-8000-000000001811', '00000000-0000-4000-8000-000000001801',
  'trace-l03-tts-fallback-free', 1,
  jsonb_build_object('displayName', 'Free Viewer', 'message', 'Namaste', 'amountPaise', '20000', 'queueIds', jsonb_build_array('00000000-0000-4000-8000-000000001821'))
);
commit;

begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000001802', true);
select * from app_private.create_manual_alert(
  '00000000-0000-0000-0000-000000003821', '00000000-0000-0000-0000-000000003822',
  '00000000-0000-4000-8000-000000001812', '00000000-0000-4000-8000-000000001802',
  'trace-l03-tts-fallback-pro', 1,
  jsonb_build_object('displayName', 'Pro Viewer', 'message', 'Shukriya', 'amountPaise', '600000', 'queueIds', jsonb_build_array('00000000-0000-4000-8000-000000001822'))
);
commit;

do $$
begin
  perform app_private.store_alert_tts_fallback_reason('00000000-0000-0000-0000-000000003811', 'tier_not_entitled');
  perform app_private.store_alert_tts_fallback_reason('00000000-0000-0000-0000-000000003821', 'quota_exhausted');
end
$$;

begin;
set local role bsa_app;
select set_config('app.overlay_session_id', '00000000-0000-4000-8000-000000001831', true);
do $$
declare
  fallback_reason text;
  watermark_flag boolean;
begin
  select payload ->> 'ttsFallbackReason', (payload ->> 'watermark')::boolean
    into fallback_reason, watermark_flag
    from app_private.get_overlay_events('00000000-0000-4000-8000-000000001831', 50)
   where event_id = '00000000-0000-0000-0000-000000003811';
  if fallback_reason <> 'tier_not_entitled' then
    raise exception 'overlay stream did not carry the free-tier fallback reason: %', fallback_reason;
  end if;
  if watermark_flag is not true then
    raise exception 'overlay stream did not mark the free-tier delivery as watermarked';
  end if;
end
$$;
commit;

begin;
set local role bsa_app;
select set_config('app.overlay_session_id', '00000000-0000-4000-8000-000000001832', true);
do $$
declare
  fallback_reason text;
  watermark_flag boolean;
begin
  select payload ->> 'ttsFallbackReason', (payload ->> 'watermark')::boolean
    into fallback_reason, watermark_flag
    from app_private.get_overlay_events('00000000-0000-4000-8000-000000001832', 50)
   where event_id = '00000000-0000-0000-0000-000000003821';
  if fallback_reason <> 'quota_exhausted' then
    raise exception 'overlay stream did not carry the pro-tier quota-exhausted fallback reason: %', fallback_reason;
  end if;
  if watermark_flag is not false then
    raise exception 'overlay stream incorrectly watermarked a pro-tier delivery';
  end if;
end
$$;
commit;

select 'L03_TTS_FALLBACK_AND_AMOUNT_LADDER=PASS' as result;
