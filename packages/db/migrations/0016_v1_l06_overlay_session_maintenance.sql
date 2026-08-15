-- BharatStudio Alerts v1 overlay-session maintenance.
--
-- This is deliberately the first concrete API maintenance mutation. The
-- acceptance ledger and the mutation execute in one caller transaction so a
-- crash cannot leave an overlay-sessions run accepted but unapplied.

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
    'overlay-sessions', 'event-archive', 'audit-archive'
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

revoke execute on function app_private.accept_maintenance_run(text, text, text) from public;
grant execute on function app_private.accept_maintenance_run(text, text, text) to bsa_app;

create or replace function app_private.run_overlay_session_maintenance(target_run_id uuid)
returns table (run_id uuid, job text, status text, expired_count integer)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  run_record public.maintenance_runs%rowtype;
  changed_count integer := 0;
begin
  select *
    into run_record
    from public.maintenance_runs
   where id = target_run_id
   for update;

  if not found then
    raise exception 'maintenance run not found';
  end if;
  if run_record.job <> 'overlay-sessions' then
    raise exception 'maintenance run is not an overlay-session job';
  end if;
  if run_record.status = 'completed' then
    return query select run_record.id, run_record.job, 'already_completed'::text, 0;
    return;
  end if;

  update public.overlay_sessions
     set revoked_at = coalesce(revoked_at, current_timestamp)
   where revoked_at is null
     and expires_at <= current_timestamp;
  get diagnostics changed_count = row_count;

  update public.maintenance_runs
     set status = 'completed', completed_at = current_timestamp
   where id = run_record.id;

  return query select run_record.id, run_record.job, 'completed'::text, changed_count;
end
$$;

revoke execute on function app_private.run_overlay_session_maintenance(uuid) from public;
grant execute on function app_private.run_overlay_session_maintenance(uuid) to bsa_app;
