-- CTL-13: application-managed passkeys for privileged platform-admin sessions.
-- Only public WebAuthn credential material, hash-only one-time challenges and
-- per-session verification time are retained. No private key, recovery secret,
-- provider token or attestation blob is stored.

alter table public.user_sessions
  add column admin_mfa_verified_at timestamptz;

create table public.platform_admin_passkeys (
  credential_id text primary key check (credential_id ~ '^[A-Za-z0-9_-]+$' and char_length(credential_id) between 16 and 2048),
  user_id uuid not null references public.app_users(id),
  public_key bytea not null check (octet_length(public_key) between 16 and 8192),
  counter bigint not null check (counter >= 0),
  transports text[] not null default '{}',
  aaguid text not null default '',
  created_at timestamptz not null default current_timestamp,
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index platform_admin_passkeys_user_active_idx
  on public.platform_admin_passkeys (user_id, created_at desc) where revoked_at is null;

create table public.platform_admin_webauthn_challenges (
  id uuid primary key,
  user_id uuid not null references public.app_users(id),
  session_id uuid not null references public.user_sessions(id),
  ceremony text not null check (ceremony in ('registration', 'authentication')),
  challenge_hash text not null check (challenge_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default current_timestamp,
  expires_at timestamptz not null,
  used_at timestamptz,
  check (expires_at > created_at)
);
create index platform_admin_webauthn_challenges_active_idx
  on public.platform_admin_webauthn_challenges (user_id, session_id, ceremony, expires_at)
  where used_at is null;

-- Audit records deliberately retain only a hash of a credential identifier.
-- Raw credential material is needed in the passkey table to verify assertions;
-- the cross-session security audit does not need it.
create table public.platform_admin_passkey_audit (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id),
  session_id uuid not null references public.user_sessions(id),
  action text not null check (action in ('registered', 'asserted')),
  credential_hash text not null check (credential_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default current_timestamp
);
create index platform_admin_passkey_audit_user_created_idx
  on public.platform_admin_passkey_audit (user_id, created_at desc);
create trigger platform_admin_passkey_audit_append_only
  before update or delete on public.platform_admin_passkey_audit
  for each row execute function app_private.reject_table_mutation();

alter table public.platform_admin_passkeys enable row level security;
alter table public.platform_admin_webauthn_challenges enable row level security;
alter table public.platform_admin_passkey_audit enable row level security;
revoke all on public.platform_admin_passkeys, public.platform_admin_webauthn_challenges, public.platform_admin_passkey_audit from public, bsa_app;

create or replace function app_private.admin_assert_current_session(target_session_id uuid)
returns void language plpgsql stable security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if not app_private.is_platform_admin() then
    raise exception 'platform staff access is required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.user_sessions s
     where s.id = target_session_id and s.user_id = app_private.current_user_id()
       and s.revoked_at is null and s.expires_at > current_timestamp
  ) then
    raise exception 'active session is required' using errcode = '42501';
  end if;
end $$;

create or replace function app_private.admin_begin_webauthn_challenge(
  challenge_id uuid, target_session_id uuid, target_ceremony text,
  target_challenge_hash text, target_expires_at timestamptz
) returns void language plpgsql volatile security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  perform app_private.admin_assert_current_session(target_session_id);
  if target_ceremony not in ('registration', 'authentication')
     or target_challenge_hash !~ '^[0-9a-f]{64}$'
     or target_expires_at <= current_timestamp then
    raise exception 'invalid WebAuthn challenge' using errcode = '22023';
  end if;
  insert into public.platform_admin_webauthn_challenges
    (id, user_id, session_id, ceremony, challenge_hash, expires_at)
  values (challenge_id, app_private.current_user_id(), target_session_id,
          target_ceremony, target_challenge_hash, target_expires_at);
end $$;

create or replace function app_private.admin_list_passkeys(target_session_id uuid)
returns table (credential_id text, public_key bytea, counter bigint, transports text[], aaguid text)
language plpgsql stable security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  perform app_private.admin_assert_current_session(target_session_id);
  return query select p.credential_id, p.public_key, p.counter, p.transports, p.aaguid
    from public.platform_admin_passkeys p
   where p.user_id = app_private.current_user_id() and p.revoked_at is null
   order by p.created_at asc;
end $$;

create or replace function app_private.admin_finish_passkey_registration(
  challenge_id uuid, target_session_id uuid, target_challenge_hash text, target_credential_id text,
  target_public_key bytea, target_counter bigint, target_transports text[], target_aaguid text
) returns void language plpgsql volatile security definer
set search_path = pg_catalog, public, app_private
as $$
declare v_user_id uuid;
begin
  perform app_private.admin_assert_current_session(target_session_id);
  update public.platform_admin_webauthn_challenges c set used_at = current_timestamp
   where c.id = challenge_id and c.user_id = app_private.current_user_id()
     and c.session_id = target_session_id and c.ceremony = 'registration' and c.challenge_hash = target_challenge_hash
     and c.used_at is null and c.expires_at > current_timestamp
   returning c.user_id into v_user_id;
  if not found then raise exception 'WebAuthn challenge is expired or already used' using errcode = '22023'; end if;
  insert into public.platform_admin_passkeys
    (credential_id, user_id, public_key, counter, transports, aaguid)
  values (target_credential_id, v_user_id, target_public_key, target_counter,
          coalesce(target_transports, '{}'), coalesce(target_aaguid, ''));
  insert into public.platform_admin_passkey_audit (user_id, session_id, action, credential_hash)
  values (v_user_id, target_session_id, 'registered', encode(sha256(convert_to(target_credential_id, 'utf8')), 'hex'));
end $$;

create or replace function app_private.admin_finish_passkey_assertion(
  challenge_id uuid, target_session_id uuid, target_challenge_hash text, target_credential_id text, target_counter bigint
) returns timestamptz language plpgsql volatile security definer
set search_path = pg_catalog, public, app_private
as $$
declare v_old_counter bigint; v_verified_at timestamptz;
begin
  perform app_private.admin_assert_current_session(target_session_id);
  update public.platform_admin_webauthn_challenges c set used_at = current_timestamp
   where c.id = challenge_id and c.user_id = app_private.current_user_id()
     and c.session_id = target_session_id and c.ceremony = 'authentication' and c.challenge_hash = target_challenge_hash
     and c.used_at is null and c.expires_at > current_timestamp;
  if not found then raise exception 'WebAuthn challenge is expired or already used' using errcode = '22023'; end if;
  select p.counter into v_old_counter from public.platform_admin_passkeys p
   where p.credential_id = target_credential_id and p.user_id = app_private.current_user_id()
     and p.revoked_at is null for update;
  if not found then raise exception 'passkey is not active for this admin' using errcode = '42501'; end if;
  if not (target_counter > v_old_counter or (target_counter = 0 and v_old_counter = 0)) then
    raise exception 'passkey counter did not advance' using errcode = '42501';
  end if;
  update public.platform_admin_passkeys set counter = target_counter, last_used_at = current_timestamp
   where credential_id = target_credential_id;
  update public.user_sessions set admin_mfa_verified_at = current_timestamp
   where id = target_session_id
   returning admin_mfa_verified_at into v_verified_at;
  insert into public.platform_admin_passkey_audit (user_id, session_id, action, credential_hash)
  values (app_private.current_user_id(), target_session_id, 'asserted', encode(sha256(convert_to(target_credential_id, 'utf8')), 'hex'));
  return v_verified_at;
end $$;

create or replace function app_private.admin_session_mfa_verified(target_session_id uuid, max_age_seconds integer)
returns boolean language plpgsql stable security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  perform app_private.admin_assert_current_session(target_session_id);
  if max_age_seconds is null or max_age_seconds < 1 then
    raise exception 'invalid MFA max age' using errcode = '22023';
  end if;
  return exists (
    select 1 from public.user_sessions s where s.id = target_session_id
      and s.admin_mfa_verified_at >= current_timestamp - make_interval(secs => max_age_seconds)
  );
end $$;

revoke all on function app_private.admin_assert_current_session(uuid) from public;
revoke all on function app_private.admin_begin_webauthn_challenge(uuid, uuid, text, text, timestamptz) from public;
revoke all on function app_private.admin_list_passkeys(uuid) from public;
revoke all on function app_private.admin_finish_passkey_registration(uuid, uuid, text, text, bytea, bigint, text[], text) from public;
revoke all on function app_private.admin_finish_passkey_assertion(uuid, uuid, text, text, bigint) from public;
revoke all on function app_private.admin_session_mfa_verified(uuid, integer) from public;
grant execute on function app_private.admin_begin_webauthn_challenge(uuid, uuid, text, text, timestamptz) to bsa_app;
grant execute on function app_private.admin_list_passkeys(uuid) to bsa_app;
grant execute on function app_private.admin_finish_passkey_registration(uuid, uuid, text, text, bytea, bigint, text[], text) to bsa_app;
grant execute on function app_private.admin_finish_passkey_assertion(uuid, uuid, text, text, bigint) to bsa_app;
grant execute on function app_private.admin_session_mfa_verified(uuid, integer) to bsa_app;
