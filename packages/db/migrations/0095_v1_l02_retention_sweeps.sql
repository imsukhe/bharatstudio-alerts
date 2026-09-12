-- L02: retention sweeps for three short-lived-secret tables that grew
-- unbounded this session, each flagged by the lane that created it:
--   - companion_device_pairings (0082) — consumed/denied/expired pairing
--     codes are never removed
--   - youtube_oauth_states (0086) — an expiry index exists, no sweep job
--   - viewer_password_reset_tokens (0088) — used/expired reset tokens are
--     never removed
--
-- Follows the accept_maintenance_run(job, key, window) -> run_<job>_
-- maintenance(run_id) two-phase protocol 0016 established and every later
-- job (0075 overlay-expiry-reminder, 0076 referral-lifecycle) reused.
-- Nothing here touches alert_events, payments, refunds, audit_events,
-- event_processing_attempts, archive_records, channel_handle_history, or
-- creator_supporter_relations — those are append-only evidence by design
-- and out of scope for this migration.
--
-- Retention windows (see per-function comments for the "genuinely
-- finished" predicate each sweep uses):
--   - companion_device_pairings: 7 days after the terminal event
--     (consumed_at, or expires_at as the transition-time proxy for
--     denied/expired). A consumed/denied/expired pairing code is dead —
--     it can never be replayed — but support gets asked "did my device
--     pair?" against a code a user already used or gave up on, so a short
--     grace window is worth keeping; unlike a password reset token there
--     is no bearer-equivalent risk in retaining it briefly.
--   - youtube_oauth_states: 0 days (delete as soon as consumed or
--     expired). This row is pure CSRF/PKCE handshake material
--     (state + code_verifier) for one in-flight OAuth redirect; once the
--     handshake completes or times out it has no support or audit value,
--     only exposure surface.
--   - viewer_password_reset_tokens: 0 days (delete as soon as used or
--     expired). A reset token is bearer-equivalent to a password reset;
--     a used or expired one has no legitimate reason to persist at all.

-- Retention-sweep index for companion_device_pairings: the existing
-- companion_device_pairings_expiry_idx is partial on the *live*
-- (pending/approved) states for the polling path; this is the mirror
-- index for the *terminal* states the retention sweep scans. The
-- predicate is state-only (immutable) — current_timestamp cannot appear
-- in a partial index predicate.
create index companion_device_pairings_retention_idx
  on public.companion_device_pairings (coalesce(consumed_at, expires_at))
  where state in ('consumed', 'denied', 'expired');

-- youtube_oauth_states already has youtube_oauth_states_expiry_idx
-- (expires_at where consumed_at is null) for the unconsumed-but-expired
-- half of the sweep; this adds the consumed half.
create index youtube_oauth_states_consumed_idx
  on public.youtube_oauth_states (consumed_at)
  where consumed_at is not null;

-- viewer_password_reset_tokens_account_idx leads with viewer_account_id,
-- so it cannot serve a global "which rows are finished" scan. Add the two
-- partial indexes the sweep actually needs.
create index viewer_password_reset_tokens_used_idx
  on viewer_password_reset_tokens (used_at)
  where used_at is not null;

create index viewer_password_reset_tokens_unused_expiry_idx
  on viewer_password_reset_tokens (expires_at)
  where used_at is null;

-- Extend the maintenance-run vocabulary with the three new jobs.
alter table public.maintenance_runs drop constraint if exists maintenance_runs_job_check;
alter table public.maintenance_runs add constraint maintenance_runs_job_check
  check (job in (
    'payment-reconcile', 'refund-reconcile', 'outbox-recover',
    'overlay-sessions', 'event-archive', 'audit-archive',
    'overlay-expiry-reminder', 'referral-lifecycle',
    'retention-companion-pairings', 'retention-youtube-oauth-states', 'retention-viewer-reset-tokens'
  ));

create or replace function app_private.accept_maintenance_run(
  target_job text,
  target_idempotency_key text,
  target_window text default null
)
returns table (run_id uuid, job text, status text)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  inserted_id uuid;
  existing public.maintenance_runs%rowtype;
begin
  if target_job not in (
    'payment-reconcile', 'refund-reconcile', 'outbox-recover',
    'overlay-sessions', 'event-archive', 'audit-archive',
    'overlay-expiry-reminder', 'referral-lifecycle',
    'retention-companion-pairings', 'retention-youtube-oauth-states', 'retention-viewer-reset-tokens'
  ) then
    raise exception 'unsupported maintenance job';
  end if;
  if length(target_idempotency_key) < 16 or length(target_idempotency_key) > 160 then
    raise exception 'invalid maintenance idempotency key';
  end if;
  if target_window is not null and (length(target_window) < 1 or length(target_window) > 80) then
    raise exception 'invalid maintenance window';
  end if;

  inserted_id := md5('maintenance:' || target_job || ':' || target_idempotency_key)::uuid;

  insert into public.maintenance_runs (id, job, idempotency_key, requested_window)
  values (inserted_id, target_job, target_idempotency_key, target_window)
  on conflict on constraint maintenance_runs_job_idempotency_key_key do nothing;

  if found then
    return query select inserted_id, target_job, 'accepted'::text;
    return;
  end if;

  select mr.* into existing
    from public.maintenance_runs mr
   where mr.job = target_job
     and mr.idempotency_key = target_idempotency_key
   for update;
  if existing.status = 'completed' then
    return query select existing.id, existing.job, 'already_completed'::text;
  else
    return query select existing.id, existing.job, 'accepted'::text;
  end if;
end
$$;

-- Sweep 1/3: companion_device_pairings. A row is genuinely finished when
-- its state has already transitioned to a terminal one (consumed, denied,
-- expired) — never inferred from expires_at alone, since a pending/
-- approved row past its TTL is "live but stale" until the poll path (or a
-- future maintenance pass) actually transitions it; deleting it early
-- would race a client still mid-poll. Batched to 500 rows with
-- `for update skip locked` so a sweep can never hold a long lock or block
-- a concurrent poll/approve/deny on a different row.
create or replace function app_private.run_retention_companion_pairings_maintenance(
  target_run_id uuid
)
returns table (run_id uuid, job text, status text, removed_count integer)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  run_record public.maintenance_runs%rowtype;
  v_removed_count integer := 0;
begin
  select mr.* into run_record from public.maintenance_runs mr where mr.id = target_run_id for update;
  if not found then
    raise exception 'maintenance run not found' using errcode = '23503';
  end if;
  if run_record.job <> 'retention-companion-pairings' then
    raise exception 'maintenance run job mismatch' using errcode = '22023';
  end if;
  if run_record.status = 'completed' then
    return query select run_record.id, run_record.job, 'already_completed'::text, 0;
    return;
  end if;

  delete from public.companion_device_pairings
   where id in (
     select cdp.id
       from public.companion_device_pairings cdp
      where cdp.state in ('consumed', 'denied', 'expired')
        and coalesce(cdp.consumed_at, cdp.expires_at) <= current_timestamp - interval '7 days'
      order by coalesce(cdp.consumed_at, cdp.expires_at)
      limit 500
        for update skip locked
   );
  get diagnostics v_removed_count = row_count;

  update public.maintenance_runs
     set status = 'completed', completed_at = current_timestamp
   where id = run_record.id;

  return query select run_record.id, run_record.job, 'completed'::text, v_removed_count;
end
$$;

-- Sweep 2/3: youtube_oauth_states. Finished = consumed (handshake
-- completed) or past expires_at (handshake abandoned/timed out) — either
-- way the state/code_verifier pair can never be used again, so there is
-- no grace window. Same 500-row batch + skip-locked bound as above.
create or replace function app_private.run_retention_youtube_oauth_states_maintenance(
  target_run_id uuid
)
returns table (run_id uuid, job text, status text, removed_count integer)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  run_record public.maintenance_runs%rowtype;
  v_removed_count integer := 0;
begin
  select mr.* into run_record from public.maintenance_runs mr where mr.id = target_run_id for update;
  if not found then
    raise exception 'maintenance run not found' using errcode = '23503';
  end if;
  if run_record.job <> 'retention-youtube-oauth-states' then
    raise exception 'maintenance run job mismatch' using errcode = '22023';
  end if;
  if run_record.status = 'completed' then
    return query select run_record.id, run_record.job, 'already_completed'::text, 0;
    return;
  end if;

  delete from public.youtube_oauth_states
   where id in (
     select yos.id
       from public.youtube_oauth_states yos
      where yos.consumed_at is not null or yos.expires_at <= current_timestamp
      order by yos.expires_at
      limit 500
        for update skip locked
   );
  get diagnostics v_removed_count = row_count;

  update public.maintenance_runs
     set status = 'completed', completed_at = current_timestamp
   where id = run_record.id;

  return query select run_record.id, run_record.job, 'completed'::text, v_removed_count;
end
$$;

-- Sweep 3/3: viewer_password_reset_tokens. Finished = used (used_at set)
-- or past expires_at — a reset token is bearer-equivalent to a password
-- reset, so there is no reason to keep it once it is either. Same
-- 500-row batch + skip-locked bound as above.
create or replace function app_private.run_retention_viewer_reset_tokens_maintenance(
  target_run_id uuid
)
returns table (run_id uuid, job text, status text, removed_count integer)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  run_record public.maintenance_runs%rowtype;
  v_removed_count integer := 0;
begin
  select mr.* into run_record from public.maintenance_runs mr where mr.id = target_run_id for update;
  if not found then
    raise exception 'maintenance run not found' using errcode = '23503';
  end if;
  if run_record.job <> 'retention-viewer-reset-tokens' then
    raise exception 'maintenance run job mismatch' using errcode = '22023';
  end if;
  if run_record.status = 'completed' then
    return query select run_record.id, run_record.job, 'already_completed'::text, 0;
    return;
  end if;

  delete from viewer_password_reset_tokens
   where id in (
     select vprt.id
       from viewer_password_reset_tokens vprt
      where vprt.used_at is not null or vprt.expires_at <= current_timestamp
      order by vprt.expires_at
      limit 500
        for update skip locked
   );
  get diagnostics v_removed_count = row_count;

  update public.maintenance_runs
     set status = 'completed', completed_at = current_timestamp
   where id = run_record.id;

  return query select run_record.id, run_record.job, 'completed'::text, v_removed_count;
end
$$;

revoke execute on function app_private.run_retention_companion_pairings_maintenance(uuid) from public;
revoke execute on function app_private.run_retention_youtube_oauth_states_maintenance(uuid) from public;
revoke execute on function app_private.run_retention_viewer_reset_tokens_maintenance(uuid) from public;

grant execute on function app_private.run_retention_companion_pairings_maintenance(uuid) to bsa_app;
grant execute on function app_private.run_retention_youtube_oauth_states_maintenance(uuid) to bsa_app;
grant execute on function app_private.run_retention_viewer_reset_tokens_maintenance(uuid) to bsa_app;
