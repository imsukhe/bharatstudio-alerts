-- L14: viewer sessions, DPDP-style deletion, opt-in profile visibility, and
-- the channel-scoped supporter-history read that a creator route will call.
--
-- DPDP deletion note (governance/AGENTS.md: privacy/legal conclusions require
-- dated primary evidence or written professional advice, not model judgment).
-- This migration builds the mechanism only: profile/linkage is erased,
-- financial and audit records are retained. Whether this mechanism, on its
-- own, satisfies DPDP is NOT asserted here — that is an open legal question
-- for counsel (see governance/AGENTS.md and L08), recorded as open in the
-- delivery report, not answered by this comment or this code.

create table viewer_sessions (
  id uuid primary key,
  viewer_account_id uuid not null references viewer_accounts(id),
  token_hash text not null,
  device_label text,
  created_at timestamptz not null default current_timestamp,
  last_seen_at timestamptz not null default current_timestamp,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  unique (token_hash)
);

create index viewer_sessions_account_idx on viewer_sessions (viewer_account_id, revoked_at, expires_at);

-- Opt-in, default OFF. No column here is ever readable by a creator route —
-- only by the viewer's own dashboard and (once opted in) a public profile
-- lookup, neither of which is a creator-scoped surface.
alter table viewer_accounts add column profile_visibility text not null default 'private' check (profile_visibility in ('private', 'public'));
alter table viewer_accounts add column profile_slug text;
create unique index viewer_accounts_profile_slug_unique on viewer_accounts (lower(profile_slug)) where profile_slug is not null and profile_visibility = 'public';

-- Explicit, provable record of what a deletion request erased vs retained.
-- One row per request; erasure is applied synchronously by
-- app_private.request_viewer_account_deletion below, so a 'completed' row
-- with its erasure_record is itself the proof, without a separate job.
create table viewer_deletion_requests (
  id uuid primary key,
  viewer_account_id uuid not null references viewer_accounts(id),
  requested_at timestamptz not null default current_timestamp,
  status text not null default 'completed' check (status in ('completed')),
  erasure_record jsonb not null
);

alter table viewer_sessions enable row level security;
alter table viewer_deletion_requests enable row level security;
revoke all on viewer_sessions, viewer_deletion_requests from public;
revoke all on viewer_sessions, viewer_deletion_requests from bsa_app;

create or replace function app_private.create_viewer_session(
  target_session_id uuid,
  target_viewer_account_id uuid,
  target_token_hash text,
  target_device_label text,
  target_expires_at timestamptz
)
returns table (session_id uuid, viewer_account_id uuid, expires_at timestamptz)
language plpgsql volatile security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if not exists (select 1 from viewer_accounts va where va.id = target_viewer_account_id and va.closed_at is null) then
    raise exception 'viewer account not found' using errcode = '42501';
  end if;
  insert into viewer_sessions (id, viewer_account_id, token_hash, device_label, expires_at)
  values (target_session_id, target_viewer_account_id, target_token_hash, nullif(target_device_label, ''), target_expires_at);
  return query select target_session_id, target_viewer_account_id, target_expires_at;
end
$$;

create or replace function app_private.lookup_viewer_session(target_token_hash text)
returns table (session_id uuid, viewer_account_id uuid, expires_at timestamptz)
language sql volatile security definer
set search_path = pg_catalog, public, app_private
as $$
  update viewer_sessions vs
     set last_seen_at = current_timestamp
    from viewer_accounts va
   where vs.token_hash = target_token_hash
     and vs.revoked_at is null
     and vs.expires_at > current_timestamp
     and va.id = vs.viewer_account_id
     and va.closed_at is null
  returning vs.id, vs.viewer_account_id, vs.expires_at
$$;

create or replace function app_private.list_viewer_sessions(target_viewer_account_id uuid)
returns table (session_id uuid, created_at timestamptz, last_seen_at timestamptz, expires_at timestamptz, device_label text)
language sql stable security definer
set search_path = pg_catalog, public, app_private
as $$
  select vs.id, vs.created_at, vs.last_seen_at, vs.expires_at, vs.device_label
    from viewer_sessions vs
   where vs.viewer_account_id = target_viewer_account_id
     and target_viewer_account_id = app_private.current_viewer_id()
     and vs.revoked_at is null
     and vs.expires_at > current_timestamp
   order by vs.last_seen_at desc
$$;

create or replace function app_private.revoke_viewer_session(target_viewer_account_id uuid, target_session_id uuid)
returns boolean
language plpgsql volatile security definer
set search_path = pg_catalog, public, app_private
as $$
declare updated_id uuid;
begin
  if target_viewer_account_id <> app_private.current_viewer_id() then
    raise exception 'viewer session access denied' using errcode = '42501';
  end if;
  update viewer_sessions
     set revoked_at = current_timestamp
   where id = target_session_id
     and viewer_account_id = target_viewer_account_id
     and revoked_at is null
  returning id into updated_id;
  return updated_id is not null;
end
$$;

-- Private lifetime dashboard: sums a viewer's OWN history across every
-- creator, by identity plus anything merged into this account (the claim
-- design from 0084). This is the one place cross-creator amounts are ever
-- assembled, and it is reachable only for app_private.current_viewer_id().
create or replace function app_private.get_viewer_dashboard(target_viewer_account_id uuid)
returns table (
  channel_id uuid, channel_handle text, channel_display_name text,
  first_supported_at timestamptz, last_supported_at timestamptz,
  lifetime_amount_paise bigint, tip_count bigint, challenge_count bigint, member_state text
)
language sql stable security definer
set search_path = pg_catalog, public, app_private
as $$
  select c.id, c.handle, c.display_name,
         csr.first_supported_at, csr.last_supported_at,
         csr.lifetime_amount_paise, csr.tip_count, csr.challenge_count, csr.member_state
    from creator_supporter_relations csr
    join channels c on c.id = csr.channel_id
    join viewer_identities vi on vi.id = csr.viewer_identity_id
   where target_viewer_account_id = app_private.current_viewer_id()
     and (vi.viewer_account_id = target_viewer_account_id or vi.merged_into_account_id = target_viewer_account_id)
   order by csr.last_supported_at desc
$$;

-- Channel-scoped supporter history for a CREATOR's own channel only. This is
-- the mechanism the L14 "most important test" proves: it is filtered by
-- can_access_channel(target_channel_id) and by channel_id in the query
-- itself, so it structurally cannot return another channel's rows no matter
-- what viewer_identity_id a caller supplies.
create or replace function app_private.get_channel_supporter_history(target_channel_id uuid)
returns table (
  viewer_identity_id uuid, first_supported_at timestamptz, last_supported_at timestamptz,
  lifetime_amount_paise bigint, tip_count bigint, challenge_count bigint, member_state text
)
language sql stable security definer
set search_path = pg_catalog, public, app_private
as $$
  select csr.viewer_identity_id, csr.first_supported_at, csr.last_supported_at,
         csr.lifetime_amount_paise, csr.tip_count, csr.challenge_count, csr.member_state
    from creator_supporter_relations csr
   where csr.channel_id = target_channel_id
     and app_private.can_access_channel(target_channel_id)
   order by csr.last_supported_at desc
$$;

-- DPDP-style deletion: erases profile/linkage, retains the immutable
-- financial/audit record. See the file-header note above — this function is
-- the mechanism, not a legal conclusion that it is sufficient.
create or replace function app_private.request_viewer_account_deletion(target_viewer_account_id uuid)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  record_id uuid := gen_random_uuid();
  erasure jsonb;
begin
  if target_viewer_account_id <> app_private.current_viewer_id() then
    raise exception 'viewer deletion access denied' using errcode = '42501';
  end if;
  update viewer_accounts
     set email = null, password_hash = null, display_name = null,
         profile_visibility = 'private', profile_slug = null,
         closed_at = coalesce(closed_at, current_timestamp),
         updated_at = current_timestamp
   where id = target_viewer_account_id;
  update viewer_sessions set revoked_at = current_timestamp
   where viewer_account_id = target_viewer_account_id and revoked_at is null;
  erasure := jsonb_build_object(
    'schemaVersion', 'v1',
    'erased', jsonb_build_array('email', 'password_hash', 'display_name', 'profile_visibility_reset_to_private', 'profile_slug', 'active_sessions'),
    'retained', jsonb_build_array('payments (financial record)', 'refunds (financial record)', 'creator_supporter_relations (financial/audit aggregate)', 'viewer_identities row id (audit linkage only, no PII)'),
    'legalDispositionOpen', true
  );
  insert into viewer_deletion_requests (id, viewer_account_id, erasure_record)
  values (record_id, target_viewer_account_id, erasure);
  return erasure;
end
$$;

revoke execute on function app_private.create_viewer_session(uuid, uuid, text, text, timestamptz) from public;
revoke execute on function app_private.lookup_viewer_session(text) from public;
revoke execute on function app_private.list_viewer_sessions(uuid) from public;
revoke execute on function app_private.revoke_viewer_session(uuid, uuid) from public;
revoke execute on function app_private.get_viewer_dashboard(uuid) from public;
revoke execute on function app_private.get_channel_supporter_history(uuid) from public;
revoke execute on function app_private.request_viewer_account_deletion(uuid) from public;
grant execute on function app_private.create_viewer_session(uuid, uuid, text, text, timestamptz) to bsa_app;
grant execute on function app_private.lookup_viewer_session(text) to bsa_app;
grant execute on function app_private.list_viewer_sessions(uuid) to bsa_app;
grant execute on function app_private.revoke_viewer_session(uuid, uuid) to bsa_app;
grant execute on function app_private.get_viewer_dashboard(uuid) to bsa_app;
grant execute on function app_private.get_channel_supporter_history(uuid) to bsa_app;
grant execute on function app_private.request_viewer_account_deletion(uuid) to bsa_app;
