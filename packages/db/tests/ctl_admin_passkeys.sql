-- CTL-13 durable passkey state proof (migration 0165). Synthetic only.
\set ON_ERROR_STOP on

insert into app_users (id, external_subject, display_name, created_at, updated_at, is_platform_admin)
values
  ('00000000-0000-4000-8000-000000006f00', 'google-ctl13-admin', 'CTL13 Admin', current_timestamp, current_timestamp, true),
  ('00000000-0000-4000-8000-000000006f01', 'google-ctl13-other', 'CTL13 Other', current_timestamp, current_timestamp, false)
on conflict (id) do nothing;
insert into user_sessions (id, user_id, token_hash, device_label, created_at, last_seen_at, expires_at)
values
  ('00000000-0000-4000-8000-000000006f02', '00000000-0000-4000-8000-000000006f00', repeat('a', 64), 'CTL13 A', current_timestamp, current_timestamp, current_timestamp + interval '1 day'),
  ('00000000-0000-4000-8000-000000006f03', '00000000-0000-4000-8000-000000006f00', repeat('b', 64), 'CTL13 B', current_timestamp, current_timestamp, current_timestamp + interval '1 day'),
  ('00000000-0000-4000-8000-000000006f04', '00000000-0000-4000-8000-000000006f01', repeat('c', 64), 'CTL13 Other', current_timestamp, current_timestamp, current_timestamp + interval '1 day')
on conflict (id) do nothing;

do $$
begin
  if has_table_privilege('bsa_app', 'public.platform_admin_passkeys', 'select') or has_table_privilege('bsa_app', 'public.platform_admin_webauthn_challenges', 'select') then
    raise exception 'CTL13: bsa_app must have no direct passkey/challenge table read';
  end if;
  if has_function_privilege('public', 'app_private.admin_finish_passkey_assertion(uuid,uuid,text,text,bigint)', 'execute') then
    raise exception 'CTL13: public must not execute assertion finalization';
  end if;
end $$;

select set_config('app.user_id', '00000000-0000-4000-8000-000000006f00', false);
select app_private.admin_begin_webauthn_challenge('00000000-0000-4000-8000-000000006f10', '00000000-0000-4000-8000-000000006f02', 'registration', repeat('a', 64), current_timestamp + interval '5 minutes');
select app_private.admin_finish_passkey_registration('00000000-0000-4000-8000-000000006f10', '00000000-0000-4000-8000-000000006f02', repeat('a', 64), repeat('A', 32), decode(repeat('aa', 32), 'hex'), 0, array['internal'], '');

do $$
begin
  if not exists (select 1 from platform_admin_passkeys where credential_id = repeat('A', 32) and user_id = '00000000-0000-4000-8000-000000006f00' and counter = 0) then
    raise exception 'CTL13: public credential must be durably registered';
  end if;
  if exists (select 1 from platform_admin_webauthn_challenges where id = '00000000-0000-4000-8000-000000006f10' and used_at is null) then
    raise exception 'CTL13: registration challenge must be consumed exactly once';
  end if;
  if not exists (select 1 from platform_admin_passkey_audit where action = 'registered' and credential_hash = encode(sha256(convert_to(repeat('A', 32), 'utf8')), 'hex')) then
    raise exception 'CTL13: registration must create a redacted audit event';
  end if;
  begin
    perform app_private.admin_finish_passkey_registration('00000000-0000-4000-8000-000000006f10', '00000000-0000-4000-8000-000000006f02', repeat('a', 64), repeat('B', 32), decode(repeat('bb', 32), 'hex'), 0, array['internal'], '');
    raise exception 'CTL13: consumed registration challenge replay must fail';
  exception when invalid_parameter_value then null;
  end;
end $$;

select app_private.admin_begin_webauthn_challenge('00000000-0000-4000-8000-000000006f11', '00000000-0000-4000-8000-000000006f02', 'authentication', repeat('b', 64), current_timestamp + interval '5 minutes');
select app_private.admin_finish_passkey_assertion('00000000-0000-4000-8000-000000006f11', '00000000-0000-4000-8000-000000006f02', repeat('b', 64), repeat('A', 32), 0);
do $$ begin
  if not app_private.admin_session_mfa_verified('00000000-0000-4000-8000-000000006f02', 60) then raise exception 'CTL13: assertion must elevate only current session'; end if;
  if app_private.admin_session_mfa_verified('00000000-0000-4000-8000-000000006f03', 60) then raise exception 'CTL13: separate session must not inherit MFA elevation'; end if;
  if not exists (select 1 from platform_admin_passkey_audit where action = 'asserted') then raise exception 'CTL13: assertion must create a redacted audit event'; end if;
end $$;

select app_private.admin_begin_webauthn_challenge('00000000-0000-4000-8000-000000006f12', '00000000-0000-4000-8000-000000006f02', 'authentication', repeat('c', 64), current_timestamp + interval '5 minutes');
select app_private.admin_finish_passkey_assertion('00000000-0000-4000-8000-000000006f12', '00000000-0000-4000-8000-000000006f02', repeat('c', 64), repeat('A', 32), 1);
do $$
begin
  if (select counter from platform_admin_passkeys where credential_id = repeat('A', 32)) <> 1 then raise exception 'CTL13: assertion must persist counter advancement'; end if;
  begin
    perform app_private.admin_finish_passkey_assertion('00000000-0000-4000-8000-000000006f12', '00000000-0000-4000-8000-000000006f02', repeat('c', 64), repeat('A', 32), 2);
    raise exception 'CTL13: assertion replay must fail';
  exception when invalid_parameter_value then null;
  end;
end $$;

select set_config('app.user_id', '00000000-0000-4000-8000-000000006f01', false);
do $$ begin
  begin
    perform * from app_private.admin_list_passkeys('00000000-0000-4000-8000-000000006f04');
    raise exception 'CTL13: non-admin cannot list passkeys';
  exception when insufficient_privilege then null;
  end;
end $$;

select 'CTL_ADMIN_PASSKEYS=PASS' as result;
