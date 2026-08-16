-- L02/L08: retention-only account lifecycle, privacy requests and versioned
-- legal-document acceptance. Account closure is soft deactivation; financial
-- and security evidence remains retained under the approved policy.

create table if not exists public.terms_documents (
  document_key text not null check (document_key in ('terms_of_service', 'privacy_notice')),
  version text not null check (char_length(version) between 1 and 80),
  content_hash text not null check (content_hash ~ '^[0-9a-fA-F]{64}$'),
  active boolean not null default false,
  published_at timestamptz,
  created_at timestamptz not null default current_timestamp,
  primary key (document_key, version)
);

create unique index if not exists terms_documents_one_active_idx
  on public.terms_documents (document_key) where active;

create table if not exists public.user_terms_acceptances (
  id uuid primary key,
  user_id uuid not null references public.app_users(id),
  document_key text not null check (document_key in ('terms_of_service', 'privacy_notice')),
  document_version text not null,
  content_hash text not null check (content_hash ~ '^[0-9a-fA-F]{64}$'),
  accepted_at timestamptz not null default current_timestamp,
  unique (user_id, document_key, document_version),
  foreign key (document_key, document_version) references public.terms_documents(document_key, version)
);

create table if not exists public.privacy_requests (
  id uuid primary key,
  user_id uuid not null references public.app_users(id),
  request_type text not null check (request_type in ('access', 'correction', 'erasure_review', 'privacy_concern')),
  details text not null default '' check (char_length(details) <= 2000),
  status text not null check (status in ('open', 'in_review', 'completed', 'rejected')) default 'open',
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  resolved_at timestamptz,
  resolution_note text
);

create index if not exists privacy_requests_user_idx
  on public.privacy_requests (user_id, created_at desc);

create table if not exists public.account_lifecycle_events (
  id uuid primary key,
  user_id uuid not null references public.app_users(id),
  action text not null check (action in ('closed', 'reopened', 'exported', 'privacy_request')),
  request_id uuid references public.privacy_requests(id),
  created_at timestamptz not null default current_timestamp
);

alter table public.terms_documents enable row level security;
alter table public.user_terms_acceptances enable row level security;
alter table public.privacy_requests enable row level security;
alter table public.account_lifecycle_events enable row level security;
revoke all on public.terms_documents, public.user_terms_acceptances, public.privacy_requests, public.account_lifecycle_events from public;
revoke all on public.terms_documents, public.user_terms_acceptances, public.privacy_requests, public.account_lifecycle_events from bsa_app;

create or replace function app_private.list_active_terms_documents()
returns table (document_key text, version text, content_hash text, published_at timestamptz)
language sql stable security definer
set search_path = pg_catalog, public, app_private
as $$
  select document_key, version, content_hash, published_at
    from public.terms_documents
   where active = true
   order by document_key
$$;

create or replace function app_private.accept_terms_document(
  target_user_id uuid,
  target_document_key text,
  target_version text,
  target_content_hash text
)
returns boolean
language plpgsql volatile security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if target_user_id is null or target_user_id <> app_private.current_user_id()
     or target_document_key not in ('terms_of_service', 'privacy_notice')
     or target_version is null or target_content_hash !~ '^[0-9a-fA-F]{64}$' then
    raise exception 'invalid terms acceptance' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.terms_documents document
     where document.document_key = target_document_key
       and document.version = target_version
       and document.content_hash = target_content_hash
       and document.active
  ) then
    raise exception 'terms document is not active or hash does not match' using errcode = '42501';
  end if;
  insert into public.user_terms_acceptances (
    id, user_id, document_key, document_version, content_hash, accepted_at
  ) values (
    gen_random_uuid(), target_user_id, target_document_key, target_version,
    lower(target_content_hash), current_timestamp
  ) on conflict (user_id, document_key, document_version) do nothing;
  return true;
end
$$;

create or replace function app_private.has_accepted_active_terms(target_user_id uuid)
returns boolean
language sql stable security definer
set search_path = pg_catalog, public, app_private
as $$
  select not exists (
    select 1 from public.terms_documents active_document
     where active_document.active
       and not exists (
         select 1 from public.user_terms_acceptances acceptance
          where acceptance.user_id = target_user_id
            and acceptance.document_key = active_document.document_key
            and acceptance.document_version = active_document.version
            and acceptance.content_hash = active_document.content_hash
       )
  )
$$;

create or replace function app_private.create_privacy_request(
  target_user_id uuid,
  target_request_type text,
  target_details text
)
returns table (request_id uuid, request_type text, status text, created_at timestamptz)
language plpgsql volatile security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  created public.privacy_requests%rowtype;
begin
  if target_user_id is null or target_user_id <> app_private.current_user_id()
     or target_request_type not in ('access', 'correction', 'erasure_review', 'privacy_concern')
     or char_length(coalesce(target_details, '')) > 2000 then
    raise exception 'invalid privacy request' using errcode = '22023';
  end if;
  insert into public.privacy_requests (id, user_id, request_type, details)
  values (gen_random_uuid(), target_user_id, target_request_type, coalesce(target_details, ''))
  returning * into created;
  insert into public.account_lifecycle_events (id, user_id, action, request_id)
  values (gen_random_uuid(), target_user_id, 'privacy_request', created.id);
  return query select created.id, created.request_type, created.status, created.created_at;
end
$$;

create or replace function app_private.list_privacy_requests(target_user_id uuid)
returns table (request_id uuid, request_type text, details text, status text, created_at timestamptz, updated_at timestamptz, resolved_at timestamptz, resolution_note text)
language sql stable security definer
set search_path = pg_catalog, public, app_private
as $$
  select request.id, request.request_type, request.details, request.status,
         request.created_at, request.updated_at, request.resolved_at, request.resolution_note
    from public.privacy_requests request
   where request.user_id = target_user_id
     and target_user_id = app_private.current_user_id()
   order by request.created_at desc
$$;

create or replace function app_private.get_account_export(target_user_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  exported jsonb;
begin
  if target_user_id is null or target_user_id <> app_private.current_user_id() then
    raise exception 'account export access denied' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'schemaVersion', 'v1',
    'exportedAt', current_timestamp,
    'user', (select jsonb_build_object('userId', user_row.id, 'displayName', user_row.display_name, 'createdAt', user_row.created_at, 'closedAt', user_row.closed_at) from public.app_users user_row where user_row.id = target_user_id),
    'channels', coalesce((select jsonb_agg(jsonb_build_object('channelId', channel.id, 'handle', channel.handle, 'displayName', channel.display_name, 'role', membership.role, 'createdAt', channel.created_at, 'closedAt', channel.closed_at) order by channel.created_at) from public.channels channel join public.channel_memberships membership on membership.channel_id = channel.id where membership.user_id = target_user_id), '[]'::jsonb),
    'sessions', coalesce((select jsonb_agg(jsonb_build_object('sessionId', session.id, 'deviceLabel', session.device_label, 'createdAt', session.created_at, 'lastSeenAt', session.last_seen_at, 'expiresAt', session.expires_at, 'revokedAt', session.revoked_at) order by session.created_at) from public.user_sessions session where session.user_id = target_user_id), '[]'::jsonb),
    'privacyRequests', coalesce((select jsonb_agg(jsonb_build_object('requestId', request.id, 'type', request.request_type, 'status', request.status, 'createdAt', request.created_at) order by request.created_at) from public.privacy_requests request where request.user_id = target_user_id), '[]'::jsonb)
  ) into exported;
  insert into public.account_lifecycle_events (id, user_id, action)
  values (gen_random_uuid(), target_user_id, 'exported');
  return exported;
end
$$;

create or replace function app_private.close_current_account(
  target_user_id uuid,
  target_reason text
)
returns timestamptz
language plpgsql volatile security definer
set search_path = pg_catalog, public, app_private
as $$
declare closed_at_value timestamptz;
begin
  if target_user_id is null or target_user_id <> app_private.current_user_id()
     or char_length(coalesce(target_reason, '')) > 500 then
    raise exception 'invalid account closure request' using errcode = '22023';
  end if;
  update public.app_users
     set closed_at = coalesce(closed_at, current_timestamp), updated_at = current_timestamp
   where id = target_user_id
   returning closed_at into closed_at_value;
  if closed_at_value is null then raise exception 'account not found' using errcode = '42501'; end if;
  update public.user_sessions set revoked_at = current_timestamp where user_id = target_user_id and revoked_at is null;
  update public.overlay_sessions session set revoked_at = current_timestamp where session.channel_id in (select channel.id from public.channels channel where channel.owner_user_id = target_user_id) and session.revoked_at is null;
  insert into public.account_lifecycle_events (id, user_id, action) values (gen_random_uuid(), target_user_id, 'closed');
  return closed_at_value;
end
$$;

create or replace function app_private.lookup_session(target_token_hash text)
returns table (session_id uuid, user_id uuid, expires_at timestamptz)
language sql stable security definer
set search_path = pg_catalog, public, app_private
as $$
  select session.id, session.user_id, session.expires_at
    from public.user_sessions session
    join public.app_users user_row on user_row.id = session.user_id
   where session.token_hash = target_token_hash
     and session.revoked_at is null
     and session.expires_at > current_timestamp
     and user_row.closed_at is null
   limit 1
$$;

revoke execute on function app_private.list_active_terms_documents() from public;
revoke execute on function app_private.accept_terms_document(uuid, text, text, text) from public;
revoke execute on function app_private.has_accepted_active_terms(uuid) from public;
revoke execute on function app_private.create_privacy_request(uuid, text, text) from public;
revoke execute on function app_private.list_privacy_requests(uuid) from public;
revoke execute on function app_private.get_account_export(uuid) from public;
revoke execute on function app_private.close_current_account(uuid, text) from public;
revoke execute on function app_private.lookup_session(text) from public;
grant execute on function app_private.list_active_terms_documents() to bsa_app;
grant execute on function app_private.accept_terms_document(uuid, text, text, text) to bsa_app;
grant execute on function app_private.has_accepted_active_terms(uuid) to bsa_app;
grant execute on function app_private.create_privacy_request(uuid, text, text) to bsa_app;
grant execute on function app_private.list_privacy_requests(uuid) to bsa_app;
grant execute on function app_private.get_account_export(uuid) to bsa_app;
grant execute on function app_private.close_current_account(uuid, text) to bsa_app;
grant execute on function app_private.lookup_session(text) to bsa_app;
