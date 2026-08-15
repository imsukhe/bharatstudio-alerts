-- BharatStudio Alerts v1 clean logical baseline — DRAFT, DO NOT RUN.
--
-- This file is an L01 contract artifact only. It is not connected to a
-- database, does not create roles, does not install extensions, and does not
-- replace the L02 RLS/security migration. Run only after owner approval,
-- independent review, isolated-database testing and a versioned migration
-- release decision.

create table app_users (
  id uuid primary key,
  external_subject text not null,
  display_name text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  closed_at timestamptz,
  unique (external_subject)
);

create table channels (
  id uuid primary key,
  owner_user_id uuid not null references app_users(id),
  handle text not null,
  display_name text not null,
  accepting_tips boolean not null default true,
  public_config_version bigint not null default 1,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  closed_at timestamptz
);

create unique index channels_handle_lower_unique on channels (lower(handle));

create table channel_memberships (
  channel_id uuid not null references channels(id),
  user_id uuid not null references app_users(id),
  role text not null check (role in ('owner', 'admin', 'operator', 'moderator', 'viewer')),
  created_at timestamptz not null,
  revoked_at timestamptz,
  primary key (channel_id, user_id)
);

create table channel_entitlement_versions (
  channel_id uuid not null references channels(id),
  version bigint not null,
  tier text not null check (tier in ('free', 'pro', 'creator', 'studio')),
  source text not null check (source = 'individual_plan'),
  values jsonb not null,
  effective_at timestamptz not null,
  created_at timestamptz not null,
  primary key (channel_id, version)
);

create table alert_queues (
  id uuid primary key,
  channel_id uuid not null references channels(id),
  name text not null,
  is_paused boolean not null default false,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  closed_at timestamptz
);

create table payment_webhook_deliveries (
  id uuid primary key,
  provider text not null check (provider = 'razorpay'),
  environment text not null check (environment in ('test', 'live')),
  connected_account_ref text not null,
  provider_event_id text not null,
  entity_type text not null check (entity_type in ('payment', 'refund', 'subscription', 'dispute')),
  entity_id text not null,
  raw_body_hash text,
  signature_verified_at timestamptz not null,
  received_at timestamptz not null,
  processing_status text not null check (processing_status in ('received', 'processed', 'quarantined', 'retryable_failure')),
  unique (provider, environment, connected_account_ref, provider_event_id)
);

create table payments (
  id uuid primary key,
  channel_id uuid not null references channels(id),
  provider text not null check (provider = 'razorpay'),
  provider_payment_id text not null,
  provider_order_id text not null,
  gross_amount_paise bigint not null check (gross_amount_paise >= 1000),
  currency text not null check (currency = 'INR'),
  status text not null check (status in ('created', 'pending', 'captured', 'failed', 'refunded', 'partially_refunded')),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (provider, provider_payment_id)
);

create table refunds (
  id uuid primary key,
  payment_id uuid not null references payments(id),
  provider_refund_id text not null,
  amount_paise bigint not null check (amount_paise > 0),
  status text not null check (status in ('requested', 'processed', 'failed', 'reversed')),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (provider_refund_id)
);

create table alert_events (
  id uuid primary key,
  channel_id uuid not null references channels(id),
  payment_id uuid references payments(id),
  source_type text not null check (source_type in ('payment', 'manual', 'companion')),
  source_id text not null,
  trace_id text not null,
  config_snapshot_version bigint not null,
  payload jsonb not null,
  created_at timestamptz not null
);

create table event_outbox (
  id uuid primary key,
  event_id uuid not null references alert_events(id),
  status text not null check (status in ('pending', 'enqueued', 'completed', 'retryable_failure', 'quarantined')),
  available_at timestamptz not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (event_id)
);

create table event_outbox_deliveries (
  id uuid primary key,
  event_id uuid not null references alert_events(id),
  outbox_id uuid not null references event_outbox(id),
  queue_id uuid not null references alert_queues(id),
  binding_id uuid not null,
  source_id text not null,
  config_snapshot_version bigint not null,
  delivery_sequence bigint not null,
  status text not null check (status in ('pending', 'ready', 'held', 'displayed', 'acknowledged', 'failed_retriable', 'quarantined', 'suppressed', 'refunded_after_display')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_action_at timestamptz,
  last_error_code text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (outbox_id, queue_id)
);

create table event_processing_attempts (
  id uuid primary key,
  delivery_id uuid not null references event_outbox_deliveries(id),
  attempt_number integer not null check (attempt_number > 0),
  status text not null,
  error_code text,
  started_at timestamptz not null,
  finished_at timestamptz,
  unique (delivery_id, attempt_number)
);

create table overlay_sessions (
  id uuid primary key,
  channel_id uuid not null references channels(id),
  token_fingerprint text not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null
);

create table overlay_cursors (
  overlay_session_id uuid not null references overlay_sessions(id),
  cursor text not null,
  last_event_id uuid,
  acknowledged_at timestamptz,
  updated_at timestamptz not null,
  primary key (overlay_session_id, cursor)
);

create table audit_events (
  id uuid primary key,
  channel_id uuid references channels(id),
  actor_user_id uuid references app_users(id),
  action text not null,
  target_type text not null,
  target_id text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null
);

create table reconciliation_work_items (
  id uuid primary key,
  kind text not null,
  idempotency_key text not null,
  status text not null check (status in ('pending', 'running', 'completed', 'retryable_failure', 'quarantined')),
  payload jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (kind, idempotency_key)
);

-- L02 must add roles, request context, RLS policies, SECURITY DEFINER
-- hardening, append-only protections and archive-transfer permissions.
