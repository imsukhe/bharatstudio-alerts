-- BharatStudio Alerts v1 security/RLS/archive draft — DRAFT, DO NOT RUN.
--
-- This follows 0001_v1_baseline.sql and is an isolated design artifact. It
-- intentionally does not create production roles or connect to a database.
-- Deployment must provision service identities separately and apply this only
-- after L02 review, isolated tests, rollback evidence and approval.
--
-- Role contract:
--   bsa_app          LOGIN/NOBYPASSRLS; ordinary request-serving API only.
--   bsa_payment      private Go payment/reconciliation service only.
--   bsa_alert_worker private Cloud Tasks alert service only.
--   bsa_migrator     separate owner/migration identity, not request-serving.
--   scheduler/client no database credentials.
--
-- bsa_payment and bsa_alert_worker bypass RLS only for their narrowly-owned
-- append-only/global work. They must not be reachable from public routes.

create schema app_private;

create or replace function app_private.current_user_id()
returns uuid
language sql
stable
security invoker
set search_path = pg_catalog, public, app_private
as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

create or replace function app_private.current_channel_id()
returns uuid
language sql
stable
security invoker
set search_path = pg_catalog, public, app_private
as $$
  select nullif(current_setting('app.channel_id', true), '')::uuid
$$;

create or replace function app_private.current_overlay_session_id()
returns uuid
language sql
stable
security invoker
set search_path = pg_catalog, public, app_private
as $$
  select nullif(current_setting('app.overlay_session_id', true), '')::uuid
$$;

create or replace function app_private.has_channel_role(target_channel uuid, allowed_roles text[])
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select exists (
    select 1
    from public.channel_memberships membership
    where membership.channel_id = target_channel
      and membership.user_id = app_private.current_user_id()
      and membership.revoked_at is null
      and membership.role = any(allowed_roles)
  )
$$;

create or replace function app_private.can_access_channel(target_channel uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select app_private.has_channel_role(
    target_channel,
    array['owner', 'admin', 'operator', 'moderator', 'viewer']::text[]
  )
$$;

create or replace function app_private.can_access_payment(target_payment uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select exists (
    select 1
    from public.payments payment
    where payment.id = target_payment
      and app_private.can_access_channel(payment.channel_id)
  )
$$;

create or replace function app_private.can_access_overlay(target_session uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select exists (
    select 1
    from public.overlay_sessions session
    where session.id = target_session
      and session.revoked_at is null
      and session.expires_at > current_timestamp
      and (
        target_session = app_private.current_overlay_session_id()
        or app_private.can_access_channel(session.channel_id)
      )
  )
$$;

-- Public tip pages use this minimised projection rather than a broad public
-- table grant. The API still applies rate limits and response policy; this
-- function prevents the request role from reading private channel columns.
create or replace function app_private.get_public_channel(target_handle text)
returns table (
  channel_id uuid,
  handle text,
  display_name text,
  accepting_tips boolean,
  public_config_version bigint
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select channel.id,
         channel.handle,
         channel.display_name,
         channel.accepting_tips,
         channel.public_config_version
    from public.channels channel
   where lower(channel.handle) = lower(target_handle)
     and channel.closed_at is null
   limit 1
$$;

-- Harden helper execution now. Deployment then adds explicit grants only to
-- the required service identities; no helper is callable by PUBLIC.
revoke execute on function app_private.current_user_id() from public;
revoke execute on function app_private.current_channel_id() from public;
revoke execute on function app_private.current_overlay_session_id() from public;
revoke execute on function app_private.has_channel_role(uuid, text[]) from public;
revoke execute on function app_private.can_access_channel(uuid) from public;
revoke execute on function app_private.can_access_payment(uuid) from public;
revoke execute on function app_private.can_access_overlay(uuid) from public;
revoke execute on function app_private.get_public_channel(text) from public;
-- Deployment must grant only the named helper functions to bsa_app,
-- bsa_payment or bsa_alert_worker as each call path requires.
-- RLS policies execute these helpers on behalf of bsa_app. They do not expose
-- tenant data by themselves; each reads only transaction-scoped context and
-- membership/ownership predicates. Without these grants, authenticated
-- inserts/updates fail at runtime even though the policy definitions parse.
grant execute on function app_private.current_user_id() to bsa_app;
grant execute on function app_private.current_channel_id() to bsa_app;
grant execute on function app_private.current_overlay_session_id() to bsa_app;
grant execute on function app_private.has_channel_role(uuid, text[]) to bsa_app;
grant execute on function app_private.can_access_channel(uuid) to bsa_app;
grant execute on function app_private.can_access_payment(uuid) to bsa_app;
grant execute on function app_private.can_access_overlay(uuid) to bsa_app;
grant execute on function app_private.get_public_channel(text) to bsa_app;

alter table public.app_users enable row level security;
alter table public.channels enable row level security;
alter table public.channel_memberships enable row level security;
alter table public.channel_entitlement_versions enable row level security;
alter table public.alert_queues enable row level security;
alter table public.payments enable row level security;
alter table public.refunds enable row level security;
alter table public.alert_events enable row level security;
alter table public.event_outbox enable row level security;
alter table public.event_outbox_deliveries enable row level security;
alter table public.event_processing_attempts enable row level security;
alter table public.overlay_sessions enable row level security;
alter table public.overlay_cursors enable row level security;
alter table public.audit_events enable row level security;
alter table public.reconciliation_work_items enable row level security;
alter table public.payment_webhook_deliveries enable row level security;

-- FORCE ROW LEVEL SECURITY is deliberately not enabled here. Owner/migrator
-- access is separate and audited; the app role is explicitly NOBYPASSRLS.

create policy users_self_select
  on public.app_users for select to bsa_app
  using (id = app_private.current_user_id());

create policy users_self_update
  on public.app_users for update to bsa_app
  using (id = app_private.current_user_id())
  with check (id = app_private.current_user_id());

create policy channels_member_select
  on public.channels for select to bsa_app
  using (app_private.can_access_channel(id));

create policy channels_owner_update
  on public.channels for update to bsa_app
  using (app_private.has_channel_role(id, array['owner', 'admin']::text[]))
  with check (app_private.has_channel_role(id, array['owner', 'admin']::text[]));

create policy channel_memberships_self_or_admin_select
  on public.channel_memberships for select to bsa_app
  using (
    user_id = app_private.current_user_id()
    or (
      channel_id = app_private.current_channel_id()
      and app_private.has_channel_role(channel_id, array['owner', 'admin']::text[])
    )
  );

create policy channel_memberships_admin_write
  on public.channel_memberships for all to bsa_app
  using (
    channel_id = app_private.current_channel_id()
    and app_private.has_channel_role(channel_id, array['owner', 'admin']::text[])
  )
  with check (
    channel_id = app_private.current_channel_id()
    and app_private.has_channel_role(channel_id, array['owner', 'admin']::text[])
  );

create policy channel_entitlements_member_select
  on public.channel_entitlement_versions for select to bsa_app
  using (app_private.can_access_channel(channel_id));

create policy channel_entitlements_owner_write
  on public.channel_entitlement_versions for insert to bsa_app
  with check (
    app_private.has_channel_role(channel_id, array['owner', 'admin']::text[])
  );

create policy queues_member_select
  on public.alert_queues for select to bsa_app
  using (app_private.can_access_channel(channel_id));

create policy queues_admin_write
  on public.alert_queues for all to bsa_app
  using (app_private.has_channel_role(channel_id, array['owner', 'admin', 'operator']::text[]))
  with check (app_private.has_channel_role(channel_id, array['owner', 'admin', 'operator']::text[]));

create policy payments_member_select
  on public.payments for select to bsa_app
  using (app_private.can_access_channel(channel_id));

create policy refunds_member_select
  on public.refunds for select to bsa_app
  using (app_private.can_access_payment(payment_id));

create policy alert_events_member_select
  on public.alert_events for select to bsa_app
  using (app_private.can_access_channel(channel_id));

create policy overlay_sessions_member_manage
  on public.overlay_sessions for all to bsa_app
  using (app_private.can_access_channel(channel_id))
  with check (app_private.can_access_channel(channel_id));

create policy overlay_cursors_scoped_select
  on public.overlay_cursors for select to bsa_app
  using (app_private.can_access_overlay(overlay_session_id));

create policy overlay_cursors_scoped_write
  on public.overlay_cursors for insert to bsa_app
  with check (app_private.can_access_overlay(overlay_session_id));

create policy audit_channel_select
  on public.audit_events for select to bsa_app
  using (channel_id is null or app_private.can_access_channel(channel_id));

create policy audit_channel_insert
  on public.audit_events for insert to bsa_app
  with check (channel_id is null or app_private.can_access_channel(channel_id));

-- These tables intentionally have no bsa_app policy. With RLS enabled, the
-- request role sees no rows. The private service roles access only their
-- handler-owned paths after OIDC/service identity verification.
--   event_outbox
--   event_outbox_deliveries
--   event_processing_attempts
--   reconciliation_work_items
--   payment_webhook_deliveries

create table archive_records (
  id uuid primary key,
  source_table text not null,
  source_record_id uuid not null,
  record_digest text not null,
  record jsonb not null,
  archived_at timestamptz not null,
  archived_by text not null,
  unique (source_table, source_record_id)
);

-- Archive records are append-only evidence. These are real grants, not
-- comments: the request role has no access; the alert worker can insert and
-- read for the private archival handler but cannot update or delete.
alter table public.archive_records enable row level security;
revoke all on public.archive_records from public;
revoke all on public.archive_records from bsa_app;
revoke all on public.archive_records from bsa_payment;
grant select, insert on public.archive_records to bsa_alert_worker;

create policy archive_worker_select
  on public.archive_records for select to bsa_alert_worker
  using (true);

create policy archive_worker_insert
  on public.archive_records for insert to bsa_alert_worker
  with check (true);

-- No UPDATE or DELETE policy/grant exists. The archival handler must use the
-- approved atomic copy/verify/relocate transaction and never mutate a stored
-- archive record.

-- Required deployment hardening, intentionally shown as review instructions:
--   * bsa_app must be NOBYPASSRLS and must fail startup if role attributes differ.
--   * bsa_payment and bsa_alert_worker must be private service identities.
--   * DATABASE_URL_WORKER-style silent fallback is prohibited.
--   * scheduler and client identities must not receive any database secret.
--   * every SECURITY DEFINER function above must have PUBLIC execution revoked.
