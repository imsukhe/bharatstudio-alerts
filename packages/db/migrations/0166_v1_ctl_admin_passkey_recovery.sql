-- CTL-13: audited, two-person recovery from lost platform-admin passkeys.
--
-- This is deliberately not a self-service reset. The target can request only
-- their own recovery from an authenticated platform-admin session, but an
-- owner and a distinct non-owner platform admin must each hold recent MFA
-- before the database revokes credentials/sessions. No recovery secret,
-- free-form reason, credential response or provider token is stored.

create table public.platform_admin_passkey_recoveries (
  id uuid primary key default gen_random_uuid(),
  target_user_id uuid not null references public.app_users(id),
  requested_at timestamptz not null default current_timestamp,
  expires_at timestamptz not null,
  status text not null check (status in ('requested', 'awaiting_second_approval', 'completed', 'expired')),
  completed_at timestamptz,
  check (expires_at > requested_at),
  check ((status = 'completed') = (completed_at is not null))
);
create unique index platform_admin_passkey_recoveries_one_active_target
  on public.platform_admin_passkey_recoveries (target_user_id)
  where status in ('requested', 'awaiting_second_approval');
create index platform_admin_passkey_recoveries_pending_idx
  on public.platform_admin_passkey_recoveries (requested_at asc)
  where status in ('requested', 'awaiting_second_approval');

create table public.platform_admin_passkey_recovery_approvals (
  recovery_id uuid not null references public.platform_admin_passkey_recoveries(id),
  approver_user_id uuid not null references public.app_users(id),
  approval_kind text not null check (approval_kind in ('owner', 'staff')),
  approved_at timestamptz not null default current_timestamp,
  primary key (recovery_id, approver_user_id),
  unique (recovery_id, approval_kind)
);

create table public.platform_admin_passkey_recovery_audit (
  id uuid primary key default gen_random_uuid(),
  recovery_id uuid not null references public.platform_admin_passkey_recoveries(id),
  target_user_id uuid not null references public.app_users(id),
  actor_user_id uuid not null references public.app_users(id),
  action text not null check (action in ('requested', 'approved_owner', 'approved_staff', 'completed')),
  created_at timestamptz not null default current_timestamp
);
create index platform_admin_passkey_recovery_audit_target_created_idx
  on public.platform_admin_passkey_recovery_audit (target_user_id, created_at desc);
create trigger platform_admin_passkey_recovery_audit_append_only
  before update or delete on public.platform_admin_passkey_recovery_audit
  for each row execute function app_private.reject_table_mutation();

alter table public.platform_admin_passkey_recoveries enable row level security;
alter table public.platform_admin_passkey_recovery_approvals enable row level security;
alter table public.platform_admin_passkey_recovery_audit enable row level security;
revoke all on public.platform_admin_passkey_recoveries, public.platform_admin_passkey_recovery_approvals, public.platform_admin_passkey_recovery_audit from public, bsa_app;

create or replace function app_private.admin_request_passkey_recovery(target_session_id uuid)
returns uuid language plpgsql volatile security definer
set search_path = pg_catalog, public, app_private
as $$
declare v_recovery_id uuid;
begin
  perform app_private.admin_assert_current_session(target_session_id);

  -- Expiry is durable, not inferred by a client clock. Expired records remain
  -- as minimised operational evidence but cannot block a new request.
  update public.platform_admin_passkey_recoveries
     set status = 'expired'
   where target_user_id = app_private.current_user_id()
     and status in ('requested', 'awaiting_second_approval')
     and expires_at <= current_timestamp;

  if not exists (
    select 1 from public.platform_admin_passkeys
     where user_id = app_private.current_user_id() and revoked_at is null
  ) then
    raise exception 'passkey recovery requires an active passkey' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.platform_admin_passkey_recoveries
     where target_user_id = app_private.current_user_id()
       and status in ('requested', 'awaiting_second_approval')
  ) then
    raise exception 'passkey recovery is already pending' using errcode = '23505';
  end if;

  insert into public.platform_admin_passkey_recoveries (target_user_id, expires_at, status)
  values (app_private.current_user_id(), current_timestamp + interval '24 hours', 'requested')
  returning id into v_recovery_id;
  insert into public.platform_admin_passkey_recovery_audit (recovery_id, target_user_id, actor_user_id, action)
  values (v_recovery_id, app_private.current_user_id(), app_private.current_user_id(), 'requested');
  return v_recovery_id;
end $$;

create or replace function app_private.admin_list_pending_passkey_recoveries(target_session_id uuid)
returns table (recovery_id uuid, target_user_id uuid, target_display_name text, requested_at timestamptz, expires_at timestamptz, owner_approved boolean, staff_approved boolean)
language plpgsql stable security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  perform app_private.admin_assert_current_session(target_session_id);
  if not app_private.admin_session_mfa_verified(target_session_id, 900) then
    raise exception 'recent passkey verification is required' using errcode = '42501';
  end if;
  return query
  select r.id, r.target_user_id, u.display_name, r.requested_at, r.expires_at,
    exists (select 1 from public.platform_admin_passkey_recovery_approvals a where a.recovery_id = r.id and a.approval_kind = 'owner'),
    exists (select 1 from public.platform_admin_passkey_recovery_approvals a where a.recovery_id = r.id and a.approval_kind = 'staff')
  from public.platform_admin_passkey_recoveries r
  join public.app_users u on u.id = r.target_user_id
  where r.status in ('requested', 'awaiting_second_approval') and r.expires_at > current_timestamp
  order by r.requested_at asc;
end $$;

create or replace function app_private.admin_approve_passkey_recovery(target_session_id uuid, target_recovery_id uuid)
returns table (status text, completed_at timestamptz) language plpgsql volatile security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  v_target_user_id uuid;
  v_expires_at timestamptz;
  v_kind text;
  v_owner_approved boolean;
  v_staff_approved boolean;
  v_completed_at timestamptz;
begin
  perform app_private.admin_assert_current_session(target_session_id);
  if not app_private.admin_session_mfa_verified(target_session_id, 900) then
    raise exception 'recent passkey verification is required' using errcode = '42501';
  end if;

  select r.target_user_id, r.expires_at into v_target_user_id, v_expires_at
    from public.platform_admin_passkey_recoveries r
   where r.id = target_recovery_id and r.status in ('requested', 'awaiting_second_approval')
   for update;
  if not found or v_expires_at <= current_timestamp then
    raise exception 'passkey recovery is unavailable' using errcode = '22023';
  end if;
  if v_target_user_id = app_private.current_user_id() then
    raise exception 'passkey recovery cannot be self-approved' using errcode = '42501';
  end if;

  v_kind := case when app_private.is_platform_owner() then 'owner' else 'staff' end;
  insert into public.platform_admin_passkey_recovery_approvals (recovery_id, approver_user_id, approval_kind)
  values (target_recovery_id, app_private.current_user_id(), v_kind)
  on conflict (recovery_id, approver_user_id) do nothing;
  insert into public.platform_admin_passkey_recovery_audit (recovery_id, target_user_id, actor_user_id, action)
  select target_recovery_id, v_target_user_id, app_private.current_user_id(),
    case when v_kind = 'owner' then 'approved_owner' else 'approved_staff' end
  where not exists (
    select 1 from public.platform_admin_passkey_recovery_audit a
     where a.recovery_id = target_recovery_id and a.actor_user_id = app_private.current_user_id()
       and a.action = case when v_kind = 'owner' then 'approved_owner' else 'approved_staff' end
  );

  select
    exists (select 1 from public.platform_admin_passkey_recovery_approvals a where a.recovery_id = target_recovery_id and a.approval_kind = 'owner'),
    exists (select 1 from public.platform_admin_passkey_recovery_approvals a where a.recovery_id = target_recovery_id and a.approval_kind = 'staff')
  into v_owner_approved, v_staff_approved;
  if v_owner_approved and v_staff_approved then
    v_completed_at := current_timestamp;
    update public.platform_admin_passkey_recoveries set status = 'completed', completed_at = v_completed_at where id = target_recovery_id;
    update public.platform_admin_passkeys set revoked_at = v_completed_at where user_id = v_target_user_id and revoked_at is null;
    update public.user_sessions set revoked_at = v_completed_at where user_id = v_target_user_id and revoked_at is null;
    insert into public.platform_admin_passkey_recovery_audit (recovery_id, target_user_id, actor_user_id, action)
    values (target_recovery_id, v_target_user_id, app_private.current_user_id(), 'completed');
    return query select 'completed'::text, v_completed_at;
    return;
  end if;

  update public.platform_admin_passkey_recoveries set status = 'awaiting_second_approval' where id = target_recovery_id;
  return query select 'awaiting_second_approval'::text, null::timestamptz;
  return;
end $$;

revoke all on function app_private.admin_request_passkey_recovery(uuid) from public;
revoke all on function app_private.admin_list_pending_passkey_recoveries(uuid) from public;
revoke all on function app_private.admin_approve_passkey_recovery(uuid, uuid) from public;
grant execute on function app_private.admin_request_passkey_recovery(uuid) to bsa_app;
grant execute on function app_private.admin_list_pending_passkey_recoveries(uuid) to bsa_app;
grant execute on function app_private.admin_approve_passkey_recovery(uuid, uuid) to bsa_app;
