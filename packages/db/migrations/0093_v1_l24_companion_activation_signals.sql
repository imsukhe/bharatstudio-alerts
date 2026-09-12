-- L24 Companion activation signals.
--
-- PROBLEM (see apps/api/src/routes/companion.ts's own header comment on
-- L24 scope): entitlement ("may this action group exist for this channel")
-- was server-enforced, but activation ("is the action's target actually
-- live right now") had no server-side signal for the obs/mirror/stream
-- groups -- only 'alerts' had one (overlay_connected, from 0003's
-- get_companion_state). A client that skips the desktop helper's own
-- local liveness check was previously unconstrained for those three
-- groups. This migration gives the server its own signal for each group.
--
-- HEARTBEAT, NOT FACT: a desktop helper's self-reported OBS connection
-- state can only ever be "as of the last time it told us" -- the helper
-- can crash, lose network, or be killed without ever reporting
-- disconnection. obs_status_reported_at is a heartbeat timestamp, and
-- app_private.get_companion_activation_state (below) treats it as stale
-- -- i.e. NOT connected -- once older than 45 seconds.
--
-- STALENESS WINDOW = 45 seconds. Chosen as roughly 2-3x a plausible
-- helper heartbeat cadence (the desktop helper is expected to re-report
-- every 15-20s, mirroring the existing OBS WebSocket v5 reconnect/ping
-- rhythm the desktop client already implements against OBS itself) --
-- long enough to absorb a single missed beat from a transient network
-- blip without flapping activation state, short enough that a genuinely
-- dead or killed helper reads as disconnected within one UI refresh
-- cycle rather than leaving stale actions looking safe to fire.
--
-- MIRROR / STREAM HONESTY: Mirror and Stream are separate products/repos
-- that report no liveness signal to this API today. Rather than omit the
-- columns (forcing another migration the moment a real signal exists) or
-- fake a value, mirror_reachable and stream_paired are modelled as always
-- false, each with the comment below explaining why. companion.ts's
-- activation gate therefore rejects every mirror_*/stream_* action with
-- the same distinguishable "not active" error entitlement alone would
-- have let through -- honest unknown-as-unavailable, not a false grant.

-- 1. Persist the one real heartbeat this migration can add: has a desktop
--    helper told us, recently, that its local OBS connection is up. This
--    lives on the existing per-desktop-instance control-session row
--    (0053) rather than a new per-channel table, because "which helper
--    reported this" and "is that helper's lease even still current" are
--    exactly the facts companion_control_sessions already tracks, and a
--    stale/revoked session's heartbeat must not count regardless of how
--    recent obs_status_reported_at looks.
alter table public.companion_control_sessions
  add column obs_connected boolean not null default false,
  add column obs_status_reported_at timestamptz;

comment on column public.companion_control_sessions.obs_connected is
  'Desktop helper self-report only, meaningful for client_type = ''desktop'' rows. Not authoritative on its own -- see obs_status_reported_at and app_private.get_companion_activation_state''s 45s staleness window.';
comment on column public.companion_control_sessions.obs_status_reported_at is
  'Heartbeat timestamp for obs_connected. A row older than 45 seconds (or any revoked/expired session) reads as NOT connected -- app_private.get_companion_activation_state never trusts a stale heartbeat.';

-- 2. Helper self-report entry point. Authenticated by knowledge of the
--    control session's own id (a server-generated random uuid, already
--    the sole credential the existing DELETE .../control-session/:id
--    route accepts alongside channelId) -- NOT by the bearer/session-
--    cookie auth the rest of Companion uses, because the desktop helper
--    that holds this session may have none (see 0082's pairing flow: the
--    desktop app only ever receives a control-session lease, never an
--    account bearer token, per 0082's own header comment). This is a
--    STATUS REPORT, not a control
--    channel: it can only ever flip its own session's obs_connected flag
--    and stamp a timestamp -- it cannot execute anything, cannot address
--    another channel's session, and widens no allowlist (L07's "no
--    general-purpose local/public API" boundary is unaffected).
create or replace function app_private.report_companion_obs_status(
  target_session_id uuid,
  target_channel_id uuid,
  target_connected boolean
)
returns boolean
language sql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
  update public.companion_control_sessions session
     set obs_connected = target_connected,
         obs_status_reported_at = current_timestamp,
         updated_at = current_timestamp
   where session.id = target_session_id
     and session.channel_id = target_channel_id
     and session.client_type = 'desktop'
     and session.revoked_at is null
     and session.lease_until > current_timestamp
  returning true
$$;

revoke execute on function app_private.report_companion_obs_status(uuid, uuid, boolean) from public;
grant execute on function app_private.report_companion_obs_status(uuid, uuid, boolean) to bsa_app;

-- 3. Extend get_companion_state (create-or-replace of 0003's function --
--    0003's file is untouched, following 0089's own precedent of
--    create-or-replacing an earlier migration's function in place rather
--    than editing that file) with the full activation picture:
--      helper_paired               -- a desktop helper currently holds a
--                                      valid (unrevoked, unexpired) lease
--      obs_connected                -- that helper's most recent heartbeat
--                                      says OBS is connected, and that
--                                      heartbeat is not stale (<= 45s old)
--      obs_status_reported_at       -- the heartbeat timestamp itself, so
--                                      callers/tests can see *why* a state
--                                      reads stale, not just that it does
--      payment_account_connected    -- an active payment account exists
--                                      (payment_accounts, 0006/0060 --
--                                      read here, not duplicated)
--      mirror_reachable             -- always false; see header comment
--      stream_paired                -- always false; see header comment
-- Postgres refuses a plain CREATE OR REPLACE when the OUT-parameter row
-- type changes shape (new columns, here) -- an explicit DROP first is
-- required, same as any other return-shape-widening function change.
drop function if exists app_private.get_companion_state(uuid);

create or replace function app_private.get_companion_state(target_channel_id uuid)
returns table (
  overlay_connected boolean,
  pending_alerts integer,
  last_updated_at timestamptz,
  helper_paired boolean,
  obs_connected boolean,
  obs_status_reported_at timestamptz,
  payment_account_connected boolean,
  mirror_reachable boolean,
  stream_paired boolean
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select exists (
           select 1 from public.overlay_sessions session
            where session.channel_id = target_channel_id
              and session.revoked_at is null
              and session.expires_at > current_timestamp
         ),
         (select count(*)::integer from public.event_outbox outbox
           join public.alert_events event on event.id = outbox.event_id
          where event.channel_id = target_channel_id
            and outbox.status in ('pending', 'enqueued', 'retryable_failure')),
         current_timestamp,
         exists (
           select 1 from public.companion_control_sessions helper
            where helper.channel_id = target_channel_id
              and helper.client_type = 'desktop'
              and helper.revoked_at is null
              and helper.lease_until > current_timestamp
         ),
         exists (
           select 1 from public.companion_control_sessions helper
            where helper.channel_id = target_channel_id
              and helper.client_type = 'desktop'
              and helper.revoked_at is null
              and helper.lease_until > current_timestamp
              and helper.obs_connected
              and helper.obs_status_reported_at > current_timestamp - interval '45 seconds'
         ),
         (select max(helper.obs_status_reported_at) from public.companion_control_sessions helper
           where helper.channel_id = target_channel_id
             and helper.client_type = 'desktop'
             and helper.revoked_at is null
             and helper.lease_until > current_timestamp),
         exists (
           select 1 from public.payment_accounts account
            where account.channel_id = target_channel_id
              and account.status = 'active'
              and account.revoked_at is null
         ),
         -- Mirror lives in a separate repo and reports no liveness signal
         -- to this API today. Modelled honestly as always-false (never
         -- omitted) rather than assumed reachable -- see header comment.
         false,
         -- Stream: same honesty, same reasoning, separate repo.
         false
   where app_private.can_access_channel(target_channel_id)
$$;

revoke execute on function app_private.get_companion_state(uuid) from public;
grant execute on function app_private.get_companion_state(uuid) to bsa_app;
