-- L02: retention sweeps for companion_device_pairings, youtube_oauth_states
-- and viewer_password_reset_tokens (migration 0095). Synthetic rows only.
-- Own fixture ids under the ...0000ee.. block (grepped clean of collisions
-- against every other file in this suite at write time).
--
-- Wrapped in begin;...rollback; so this never leaves fixture data behind
-- for later tests in the shared disposable database (l05_queue_policy_
-- enforcement.sql's earlier cross-test pollution incident).
begin;

insert into app_users (id, external_subject, display_name, created_at, updated_at) values
  ('00000000-0000-4000-8000-0000ee000001', 'ext-retention-001', 'Retention Owner', now(), now())
on conflict (id) do nothing;

insert into channels (id, owner_user_id, handle, display_name, accepting_tips, public_config_version, created_at, updated_at) values
  ('00000000-0000-4000-8000-0000ee000011', '00000000-0000-4000-8000-0000ee000001', 'retentiontestchan', 'Retention Test Channel', true, 1, current_timestamp, current_timestamp)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- companion_device_pairings: one live (pending, not yet expired), one
-- finished-but-within-grace (consumed 1 hour ago), one finished-and-old
-- (expired 8 days ago). The sweep must remove only the third.
-- ---------------------------------------------------------------------
insert into public.companion_device_pairings
  (id, user_code, device_code_fingerprint, client_type, client_instance_id, client_label, channel_id, state, created_at, expires_at, consumed_at)
values
  ('00000000-0000-4000-8000-0000ee000101', 'AAAA2222', 'fp-retention-live', 'desktop', 'instance-retention-live-0001', 'Live Device', '00000000-0000-4000-8000-0000ee000011', 'pending', current_timestamp, current_timestamp + interval '5 minutes', null),
  ('00000000-0000-4000-8000-0000ee000102', 'BBBB3333', 'fp-retention-fresh', 'desktop', 'instance-retention-fresh-0002', 'Fresh Consumed Device', '00000000-0000-4000-8000-0000ee000011', 'consumed', current_timestamp - interval '2 days', current_timestamp - interval '2 days', current_timestamp - interval '1 hour'),
  ('00000000-0000-4000-8000-0000ee000103', 'CCCC4444', 'fp-retention-old', 'desktop', 'instance-retention-old-0003', 'Old Expired Device', '00000000-0000-4000-8000-0000ee000011', 'expired', current_timestamp - interval '10 days', current_timestamp - interval '8 days', null);

-- ---------------------------------------------------------------------
-- youtube_oauth_states: one live (unconsumed, not expired), one finished
-- (consumed just now — zero grace window means it must go immediately).
-- ---------------------------------------------------------------------
insert into youtube_oauth_states (id, channel_id, user_id, state, code_verifier, redirect_uri, created_at, expires_at, consumed_at) values
  ('00000000-0000-4000-8000-0000ee000201', '00000000-0000-4000-8000-0000ee000011', '00000000-0000-4000-8000-0000ee000001', repeat('s', 20), repeat('v', 50), 'https://app.example.com/oauth/callback', current_timestamp, current_timestamp + interval '10 minutes', null),
  ('00000000-0000-4000-8000-0000ee000202', '00000000-0000-4000-8000-0000ee000011', '00000000-0000-4000-8000-0000ee000001', repeat('t', 20), repeat('w', 50), 'https://app.example.com/oauth/callback', current_timestamp - interval '5 minutes', current_timestamp + interval '5 minutes', current_timestamp);

-- ---------------------------------------------------------------------
-- viewer_password_reset_tokens: one live (unused, not expired), one
-- finished (used just now — zero grace window means it must go
-- immediately too).
-- ---------------------------------------------------------------------
select viewer_account_id
  from app_private.create_viewer_account('00000000-0000-4000-8000-0000ee0000d1', 'retention-viewer@example.com', repeat('x', 32), 'Retention Viewer')
\gset viewer_

insert into viewer_password_reset_tokens (id, viewer_account_id, token_hash, created_at, expires_at, used_at) values
  ('00000000-0000-4000-8000-0000ee000301', :'viewer_viewer_account_id', 'retention-token-hash-live', current_timestamp, current_timestamp + interval '30 minutes', null),
  ('00000000-0000-4000-8000-0000ee000302', :'viewer_viewer_account_id', 'retention-token-hash-used', current_timestamp - interval '20 minutes', current_timestamp + interval '10 minutes', current_timestamp);

-- ---------------------------------------------------------------------
-- Empty-table no-op check happens implicitly for none of these (all three
-- are seeded), so exercise it directly first against a table with zero
-- eligible rows using a throwaway idempotency key, before the real sweep
-- below touches any row: run the companion-pairing sweep against a
-- database state where nothing is old enough yet is covered by the
-- "unchanged row counts" assertions further down instead — Postgres has no
-- cheap way to snapshot-and-restore mid-file, so the no-op guarantee is
-- proven the standard way: run once with nothing eligible, assert
-- removed_count = 0, and confirm no error/exception on an empty result.
-- ---------------------------------------------------------------------
do $$
declare v_run_id uuid; v_job text; v_status text; v_removed int;
begin
  select run_id, job, status into v_run_id, v_job, v_status
    from app_private.accept_maintenance_run('retention-companion-pairings', 'l02-retention-noop-precheck-001');
  assert v_status = 'accepted', 'accept_maintenance_run must accept the job, got: ' || v_status;

  -- Nothing is eligible yet under this idempotency key's run because the
  -- fixture pairing rows above are seeded but this is a *different*,
  -- throwaway run — run it against a moment before any eligible row
  -- exists by scoping to a pairing that does not exist: simplest is to
  -- just prove the function tolerates a run with zero matches by running
  -- it once here (fixture row 103 is already 8-days-old and eligible, so
  -- this run legitimately claims it) — see the dedicated real-sweep
  -- assertions below for per-row correctness; this block only proves a
  -- run never errors and always reports a status/count.
  select run_id, job, status, removed_count into v_run_id, v_job, v_status, v_removed
    from app_private.run_retention_companion_pairings_maintenance(v_run_id);
  assert v_status = 'completed', 'sweep must complete, got: ' || v_status;
  assert v_removed = 1, 'expected exactly the one old-expired fixture row removed, got: ' || v_removed::text;

  -- Re-running the same accepted run must be idempotent (already_completed,
  -- no second deletion attempt) — the two-phase protocol's own guarantee,
  -- not something this sweep reimplements.
  select run_id, job, status, removed_count into v_run_id, v_job, v_status, v_removed
    from app_private.run_retention_companion_pairings_maintenance(v_run_id);
  assert v_status = 'already_completed', 'repeat run must report already_completed, got: ' || v_status;
end
$$;

-- A genuinely empty-of-eligible-rows sweep (nothing left to remove) must
-- still complete cleanly and report zero, not error.
do $$
declare v_run_id uuid; v_status text; v_removed int;
begin
  select run_id into v_run_id from app_private.accept_maintenance_run('retention-companion-pairings', 'l02-retention-noop-second-001');
  select status, removed_count into v_status, v_removed from app_private.run_retention_companion_pairings_maintenance(v_run_id);
  assert v_status = 'completed', 'no-op sweep must still complete, got: ' || v_status;
  assert v_removed = 0, 'no-op sweep must report zero removed, got: ' || v_removed::text;
end
$$;

-- companion_device_pairings: live and fresh-consumed rows survive; only the
-- 8-day-old expired row was removed (already proven above by the count).
do $$
begin
  perform 1 from public.companion_device_pairings where id = '00000000-0000-4000-8000-0000ee000101';
  assert found, 'live pending pairing must survive the sweep';
  perform 1 from public.companion_device_pairings where id = '00000000-0000-4000-8000-0000ee000102';
  assert found, 'freshly consumed pairing (within the 7-day grace window) must survive the sweep';
  perform 1 from public.companion_device_pairings where id = '00000000-0000-4000-8000-0000ee000103';
  assert not found, 'the 8-day-old expired pairing must have been removed';
end
$$;

-- youtube_oauth_states sweep: zero grace window, so the consumed row must
-- go immediately while the live row survives.
do $$
declare v_run_id uuid; v_status text; v_removed int;
begin
  select run_id into v_run_id from app_private.accept_maintenance_run('retention-youtube-oauth-states', 'l02-retention-yt-oauth-001');
  select status, removed_count into v_status, v_removed from app_private.run_retention_youtube_oauth_states_maintenance(v_run_id);
  assert v_status = 'completed', 'youtube oauth state sweep must complete, got: ' || v_status;
  assert v_removed = 1, 'expected exactly one consumed oauth state removed, got: ' || v_removed::text;

  perform 1 from youtube_oauth_states where id = '00000000-0000-4000-8000-0000ee000201';
  assert found, 'live unconsumed oauth state must survive the sweep';
  perform 1 from youtube_oauth_states where id = '00000000-0000-4000-8000-0000ee000202';
  assert not found, 'consumed oauth state must have been removed immediately';
end
$$;

-- viewer_password_reset_tokens sweep: zero grace window, so the used token
-- must go immediately while the live token survives.
do $$
declare v_run_id uuid; v_status text; v_removed int;
begin
  select run_id into v_run_id from app_private.accept_maintenance_run('retention-viewer-reset-tokens', 'l02-retention-reset-tokens-001');
  select status, removed_count into v_status, v_removed from app_private.run_retention_viewer_reset_tokens_maintenance(v_run_id);
  assert v_status = 'completed', 'reset token sweep must complete, got: ' || v_status;
  assert v_removed = 1, 'expected exactly one used reset token removed, got: ' || v_removed::text;

  perform 1 from viewer_password_reset_tokens where id = '00000000-0000-4000-8000-0000ee000301';
  assert found, 'live unused reset token must survive the sweep';
  perform 1 from viewer_password_reset_tokens where id = '00000000-0000-4000-8000-0000ee000302';
  assert not found, 'used reset token must have been removed immediately';
end
$$;

-- Batch-limit safety: the sweep functions cap at 500 rows per invocation.
-- Proving the cap fires exactly at 500 would require seeding 500+ rows,
-- which is disproportionate for this fixture; instead this asserts the
-- documented contract directly against the function body via the
-- information schema, so a future edit that silently drops the LIMIT is
-- caught here rather than only in a slow full-scale test.
do $$
declare v_src text;
begin
  select pg_get_functiondef(oid) into v_src
    from pg_proc where proname = 'run_retention_companion_pairings_maintenance' and pronamespace = 'app_private'::regnamespace;
  assert v_src like '%limit 500%', 'companion pairing sweep must stay batch-limited to 500 rows';

  select pg_get_functiondef(oid) into v_src
    from pg_proc where proname = 'run_retention_youtube_oauth_states_maintenance' and pronamespace = 'app_private'::regnamespace;
  assert v_src like '%limit 500%', 'youtube oauth state sweep must stay batch-limited to 500 rows';

  select pg_get_functiondef(oid) into v_src
    from pg_proc where proname = 'run_retention_viewer_reset_tokens_maintenance' and pronamespace = 'app_private'::regnamespace;
  assert v_src like '%limit 500%', 'viewer reset token sweep must stay batch-limited to 500 rows';
end
$$;

rollback;
