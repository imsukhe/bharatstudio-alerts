-- BharatStudio Alerts v1 scheduler-run ledger.
-- Scheduler delivery is not business mutation. This ledger makes the private
-- maintenance boundary idempotent before individual job handlers are wired.

create table if not exists public.maintenance_runs (
  id uuid primary key,
  job text not null check (job in (
    'payment-reconcile',
    'refund-reconcile',
    'outbox-recover',
    'overlay-sessions',
    'event-archive',
    'audit-archive'
  )),
  idempotency_key text not null check (length(idempotency_key) between 16 and 160),
  requested_window text check (requested_window is null or length(requested_window) between 1 and 80),
  status text not null default 'accepted' check (status in ('accepted', 'completed', 'failed_retriable')),
  created_at timestamptz not null default current_timestamp,
  completed_at timestamptz,
  constraint maintenance_runs_job_idempotency_key_key unique (job, idempotency_key)
);

revoke all on public.maintenance_runs from public;
revoke all on public.maintenance_runs from bsa_app;

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
  else
    return query
      select existing.id, existing.job, 'already_completed'::text
        from public.maintenance_runs existing
       where existing.job = target_job
         and existing.idempotency_key = target_idempotency_key;
  end if;
end
$$;

revoke execute on function app_private.accept_maintenance_run(text, text, text) from public;
grant execute on function app_private.accept_maintenance_run(text, text, text) to bsa_app;
