-- CTL-13 lost-passkey recovery proof (migration 0166). Synthetic only.
\set ON_ERROR_STOP on

insert into app_users (id, external_subject, display_name, created_at, updated_at, is_platform_admin, is_platform_owner)
values
  ('00000000-0000-4000-8000-000000007f00', 'google-ctl13-recovery-target', 'Recovery Target', current_timestamp, current_timestamp, true, false),
  ('00000000-0000-4000-8000-000000007f01', 'google-ctl13-recovery-owner', 'Recovery Owner', current_timestamp, current_timestamp, true, true),
  ('00000000-0000-4000-8000-000000007f02', 'google-ctl13-recovery-staff', 'Recovery Staff', current_timestamp, current_timestamp, true, false)
on conflict (id) do nothing;

insert into user_sessions (id, user_id, token_hash, device_label, created_at, last_seen_at, expires_at, admin_mfa_verified_at)
values
  ('00000000-0000-4000-8000-000000007f10', '00000000-0000-4000-8000-000000007f00', repeat('a', 64), 'Recovery target', current_timestamp, current_timestamp, current_timestamp + interval '1 day', null),
  ('00000000-0000-4000-8000-000000007f11', '00000000-0000-4000-8000-000000007f00', repeat('b', 64), 'Recovery target second', current_timestamp, current_timestamp, current_timestamp + interval '1 day', null),
  ('00000000-0000-4000-8000-000000007f12', '00000000-0000-4000-8000-000000007f01', repeat('c', 64), 'Recovery owner', current_timestamp, current_timestamp, current_timestamp + interval '1 day', current_timestamp),
  ('00000000-0000-4000-8000-000000007f13', '00000000-0000-4000-8000-000000007f02', repeat('d', 64), 'Recovery staff', current_timestamp, current_timestamp, current_timestamp + interval '1 day', current_timestamp)
on conflict (id) do nothing;
insert into platform_admin_passkeys (credential_id, user_id, public_key, counter)
values (repeat('R', 32), '00000000-0000-4000-8000-000000007f00', decode(repeat('aa', 32), 'hex'), 0)
on conflict (credential_id) do nothing;

do $$
begin
  if has_table_privilege('bsa_app', 'public.platform_admin_passkey_recoveries', 'select')
     or has_table_privilege('bsa_app', 'public.platform_admin_passkey_recovery_approvals', 'insert')
     or has_table_privilege('public', 'public.platform_admin_passkey_recovery_audit', 'select') then
    raise exception 'CTL13 recovery: all recovery tables must remain function-only';
  end if;
  if has_function_privilege('public', 'app_private.admin_approve_passkey_recovery(uuid,uuid)', 'execute') then
    raise exception 'CTL13 recovery: public cannot approve recovery';
  end if;
end $$;

select set_config('app.user_id', '00000000-0000-4000-8000-000000007f00', false);
select app_private.admin_request_passkey_recovery('00000000-0000-4000-8000-000000007f10');
do $$
declare v_recovery_id uuid;
begin
  select id into v_recovery_id from platform_admin_passkey_recoveries where target_user_id = '00000000-0000-4000-8000-000000007f00' and status = 'requested';
  if v_recovery_id is null then
    raise exception 'CTL13 recovery: self-targeted request must be durable';
  end if;
  begin
    perform app_private.admin_approve_passkey_recovery('00000000-0000-4000-8000-000000007f10', v_recovery_id);
    raise exception 'CTL13 recovery: target cannot self-approve';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('app.user_id', '00000000-0000-4000-8000-000000007f01', false);
select * from app_private.admin_approve_passkey_recovery('00000000-0000-4000-8000-000000007f12', (select id from platform_admin_passkey_recoveries where target_user_id = '00000000-0000-4000-8000-000000007f00'));
do $$ declare v_recovery_id uuid; begin
  select id into v_recovery_id from platform_admin_passkey_recoveries where target_user_id = '00000000-0000-4000-8000-000000007f00';
  if (select status from platform_admin_passkey_recoveries where id = v_recovery_id) <> 'awaiting_second_approval' then
    raise exception 'CTL13 recovery: first owner approval must not reset credentials';
  end if;
  if exists (select 1 from platform_admin_passkeys where user_id = '00000000-0000-4000-8000-000000007f00' and revoked_at is not null) then
    raise exception 'CTL13 recovery: first approval must not revoke credentials';
  end if;
end $$;

select set_config('app.user_id', '00000000-0000-4000-8000-000000007f02', false);
select * from app_private.admin_approve_passkey_recovery('00000000-0000-4000-8000-000000007f13', (select id from platform_admin_passkey_recoveries where target_user_id = '00000000-0000-4000-8000-000000007f00'));
do $$
declare v_recovery_id uuid;
begin
  select id into v_recovery_id from platform_admin_passkey_recoveries where target_user_id = '00000000-0000-4000-8000-000000007f00';
  if not exists (select 1 from platform_admin_passkey_recoveries where id = v_recovery_id and status = 'completed' and completed_at is not null) then
    raise exception 'CTL13 recovery: owner plus distinct staff approval must complete';
  end if;
  if exists (select 1 from platform_admin_passkeys where user_id = '00000000-0000-4000-8000-000000007f00' and revoked_at is null) then
    raise exception 'CTL13 recovery: completion must revoke every old passkey';
  end if;
  if exists (select 1 from user_sessions where user_id = '00000000-0000-4000-8000-000000007f00' and revoked_at is null) then
    raise exception 'CTL13 recovery: completion must revoke every target session';
  end if;
  if (select count(*) from platform_admin_passkey_recovery_audit where recovery_id = v_recovery_id) <> 4 then
    raise exception 'CTL13 recovery: request, two approvals and completion require append-only audit';
  end if;
end $$;

select 'CTL_ADMIN_PASSKEY_RECOVERY=PASS' as result;
