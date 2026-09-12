-- L24 Companion activation signals (0093). Executed in the isolated
-- PostgreSQL harness after migrations 0001-0093.
--
-- Proves:
--   - helper_paired reflects a live (unrevoked, unexpired) desktop
--     control-session lease and nothing else;
--   - obs_connected is true only for a FRESH heartbeat (<= 45s old) from
--     that same live session; a stale heartbeat (or none at all) reads
--     as NOT connected, even though the underlying obs_connected column
--     on the row is still literally `true`;
--   - payment_account_connected reflects an active, unrevoked
--     payment_accounts row and nothing else;
--   - mirror_reachable / stream_paired are always false;
--   - app_private.report_companion_obs_status only ever updates a
--     session that is (a) the exact session id given, (b) on the exact
--     channel given, (c) client_type = 'desktop', and (d) currently
--     unrevoked and unexpired -- so it cannot be used to report on
--     behalf of another channel, another session, or a dead session.
--
-- NOTE on set_config: get_companion_state is gated by
-- app_private.can_access_channel, which reads app_private.current_user_id()
-- from the app.user_id GUC. set_config(..., true) is transaction-local, and
-- each top-level statement in this script is its own implicit (autocommit)
-- transaction -- so `perform set_config(...)` is called as the FIRST
-- statement inside every `do $$ ... $$` block that (transitively) needs it,
-- not as a preceding standalone statement, matching the convention already
-- used elsewhere in this suite (e.g. packages/db/tests/l24_companion_action_catalogue.sql).

insert into app_users (id, external_subject, display_name, created_at, updated_at)
values ('00000000-0000-4000-8000-000000000c01', 'google-l24-activation-creator', 'Synthetic Activation Creator', current_timestamp, current_timestamp)
on conflict (id) do nothing;

-- Channel used for the positive (fresh heartbeat) and payment-account cases.
insert into channels (id, owner_user_id, handle, display_name, accepting_tips, public_config_version, created_at, updated_at)
values ('00000000-0000-4000-8000-000000000c11', '00000000-0000-4000-8000-000000000c01', 'l24_activation_a', 'L24 Activation A', true, 1, current_timestamp, current_timestamp)
on conflict (id) do nothing;
insert into channel_memberships (channel_id, user_id, role, created_at)
values ('00000000-0000-4000-8000-000000000c11', '00000000-0000-4000-8000-000000000c01', 'owner', current_timestamp)
on conflict do nothing;

-- A second channel, used only to prove report_companion_obs_status cannot
-- be used cross-channel.
insert into channels (id, owner_user_id, handle, display_name, accepting_tips, public_config_version, created_at, updated_at)
values ('00000000-0000-4000-8000-000000000c12', '00000000-0000-4000-8000-000000000c01', 'l24_activation_b', 'L24 Activation B', true, 1, current_timestamp, current_timestamp)
on conflict (id) do nothing;
insert into channel_memberships (channel_id, user_id, role, created_at)
values ('00000000-0000-4000-8000-000000000c12', '00000000-0000-4000-8000-000000000c01', 'owner', current_timestamp)
on conflict do nothing;

-- === No helper paired at all: everything reads unpaired/disconnected ===
do $$
declare
  state record;
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000c01', true);
  select * into state from app_private.get_companion_state('00000000-0000-4000-8000-000000000c11'::uuid);
  if state.helper_paired is distinct from false or state.obs_connected is distinct from false then
    raise exception 'expected no helper paired / no OBS connection with zero control sessions, got helper_paired=%, obs_connected=%', state.helper_paired, state.obs_connected;
  end if;
  if state.mirror_reachable is distinct from false or state.stream_paired is distinct from false then
    raise exception 'mirror_reachable/stream_paired must always be false (0093 models them honestly), got mirror=%, stream=%', state.mirror_reachable, state.stream_paired;
  end if;
  if state.payment_account_connected is distinct from false then
    raise exception 'expected no payment account connected before one is inserted, got %', state.payment_account_connected;
  end if;
end
$$;

-- === A live desktop session with a FRESH heartbeat: helper_paired and
--     obs_connected both true ===
insert into companion_control_sessions (
  id, channel_id, user_id, client_type, client_instance_id,
  lease_until, created_at, updated_at, obs_connected, obs_status_reported_at
) values (
  '00000000-0000-4000-8000-000000000c21', '00000000-0000-4000-8000-000000000c11', '00000000-0000-4000-8000-000000000c01',
  'desktop', 'synthetic-desktop-instance-aaaa',
  current_timestamp + interval '5 minutes', current_timestamp, current_timestamp,
  true, current_timestamp
);

do $$
declare
  state record;
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000c01', true);
  select * into state from app_private.get_companion_state('00000000-0000-4000-8000-000000000c11'::uuid);
  if state.helper_paired is distinct from true then
    raise exception 'expected helper_paired=true with a live unexpired desktop session, got %', state.helper_paired;
  end if;
  if state.obs_connected is distinct from true then
    raise exception 'expected obs_connected=true with a fresh (0s old) heartbeat, got %', state.obs_connected;
  end if;
  if state.obs_status_reported_at is null then
    raise exception 'expected obs_status_reported_at to surface the heartbeat timestamp';
  end if;
end
$$;

-- === Same session, but the heartbeat is now stale (backdated past the
--     45-second window): obs_connected must read false even though the
--     stored obs_connected column is still literally true, and
--     helper_paired (which depends only on the lease, not the heartbeat)
--     must remain true ===
update companion_control_sessions
   set obs_status_reported_at = current_timestamp - interval '90 seconds'
 where id = '00000000-0000-4000-8000-000000000c21';

do $$
declare
  state record;
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000c01', true);
  select * into state from app_private.get_companion_state('00000000-0000-4000-8000-000000000c11'::uuid);
  if state.helper_paired is distinct from true then
    raise exception 'a stale OBS heartbeat must not affect helper_paired, got %', state.helper_paired;
  end if;
  if state.obs_connected is distinct from false then
    raise exception 'a 90s-old heartbeat is well past the 45s staleness window and must read as NOT connected, got %', state.obs_connected;
  end if;
end
$$;

-- === Revoking the session: helper_paired must flip to false regardless
--     of how fresh a heartbeat looks ===
update companion_control_sessions
   set obs_status_reported_at = current_timestamp,
       revoked_at = current_timestamp,
       revoked_reason = 'test_revoked'
 where id = '00000000-0000-4000-8000-000000000c21';

do $$
declare
  state record;
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000c01', true);
  select * into state from app_private.get_companion_state('00000000-0000-4000-8000-000000000c11'::uuid);
  if state.helper_paired is distinct from false or state.obs_connected is distinct from false then
    raise exception 'a revoked session must read as unpaired/disconnected regardless of heartbeat freshness, got helper_paired=%, obs_connected=%', state.helper_paired, state.obs_connected;
  end if;
end
$$;

-- === payment_account_connected reflects an active payment account ===
insert into payment_accounts (id, channel_id, provider, environment, connected_account_ref, status, created_at, updated_at)
values ('00000000-0000-4000-8000-000000000c31', '00000000-0000-4000-8000-000000000c11', 'razorpay', 'live', 'acct_l24_activation', 'active', current_timestamp, current_timestamp);

do $$
declare
  state record;
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000c01', true);
  select * into state from app_private.get_companion_state('00000000-0000-4000-8000-000000000c11'::uuid);
  if state.payment_account_connected is distinct from true then
    raise exception 'expected payment_account_connected=true with an active payment account, got %', state.payment_account_connected;
  end if;
end
$$;

-- A revoked payment account must not count.
update payment_accounts set status = 'revoked', revoked_at = current_timestamp where id = '00000000-0000-4000-8000-000000000c31';

do $$
declare
  state record;
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000c01', true);
  select * into state from app_private.get_companion_state('00000000-0000-4000-8000-000000000c11'::uuid);
  if state.payment_account_connected is distinct from false then
    raise exception 'a revoked payment account must not count as connected, got %', state.payment_account_connected;
  end if;
end
$$;

-- === report_companion_obs_status: the helper self-report entry point ===
-- Note: report_companion_obs_status itself needs no app.user_id -- it is
-- authenticated purely by (session id, channel id, client_type='desktop',
-- unrevoked, unexpired), by design (see migration 0093 and companion.ts's
-- doc comment on this endpoint). set_config is only needed here for the
-- get_companion_state calls that observe the result.

-- Fresh live session to report against.
insert into companion_control_sessions (
  id, channel_id, user_id, client_type, client_instance_id,
  lease_until, created_at, updated_at
) values (
  '00000000-0000-4000-8000-000000000c22', '00000000-0000-4000-8000-000000000c11', '00000000-0000-4000-8000-000000000c01',
  'desktop', 'synthetic-desktop-instance-bbbb',
  current_timestamp + interval '5 minutes', current_timestamp, current_timestamp
);

do $$
declare
  reported boolean;
  state record;
begin
  -- Correct session id + correct channel id: succeeds and is visible via
  -- get_companion_state immediately.
  select app_private.report_companion_obs_status(
    '00000000-0000-4000-8000-000000000c22'::uuid, '00000000-0000-4000-8000-000000000c11'::uuid, true
  ) into reported;
  if reported is distinct from true then
    raise exception 'expected report_companion_obs_status to succeed for its own session/channel, got %', reported;
  end if;
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000c01', true);
  select * into state from app_private.get_companion_state('00000000-0000-4000-8000-000000000c11'::uuid);
  if state.obs_connected is distinct from true then
    raise exception 'expected obs_connected=true immediately after a successful report, got %', state.obs_connected;
  end if;

  -- Correct session id, but the WRONG channel id: must fail, and must not
  -- report on the other channel's behalf either.
  select app_private.report_companion_obs_status(
    '00000000-0000-4000-8000-000000000c22'::uuid, '00000000-0000-4000-8000-000000000c12'::uuid, true
  ) into reported;
  if reported is distinct from false and reported is not null then
    raise exception 'a session id paired with the wrong channel id must not report, got %', reported;
  end if;

  -- A session id that does not exist at all: must fail closed, not error.
  select app_private.report_companion_obs_status(
    '00000000-0000-4000-8000-000000000cff'::uuid, '00000000-0000-4000-8000-000000000c11'::uuid, true
  ) into reported;
  if reported is distinct from false and reported is not null then
    raise exception 'an unknown session id must not report, got %', reported;
  end if;
end
$$;

-- A revoked session can no longer report, even against its own channel.
update companion_control_sessions
   set revoked_at = current_timestamp, revoked_reason = 'test_revoked'
 where id = '00000000-0000-4000-8000-000000000c22';

do $$
declare
  reported boolean;
begin
  select app_private.report_companion_obs_status(
    '00000000-0000-4000-8000-000000000c22'::uuid, '00000000-0000-4000-8000-000000000c11'::uuid, false
  ) into reported;
  if reported is distinct from false and reported is not null then
    raise exception 'a revoked session must not be able to report, got %', reported;
  end if;
end
$$;

-- A 'web' control session (not 'desktop') must not be reportable either --
-- report_companion_obs_status is a desktop-helper-only surface.
insert into companion_control_sessions (
  id, channel_id, user_id, client_type, client_instance_id,
  lease_until, created_at, updated_at
) values (
  '00000000-0000-4000-8000-000000000c23', '00000000-0000-4000-8000-000000000c11', '00000000-0000-4000-8000-000000000c01',
  'web', 'synthetic-web-instance-cccc',
  current_timestamp + interval '5 minutes', current_timestamp, current_timestamp
);

do $$
declare
  reported boolean;
begin
  select app_private.report_companion_obs_status(
    '00000000-0000-4000-8000-000000000c23'::uuid, '00000000-0000-4000-8000-000000000c11'::uuid, true
  ) into reported;
  if reported is distinct from false and reported is not null then
    raise exception 'a non-desktop control session must not be able to report OBS status, got %', reported;
  end if;
end
$$;
