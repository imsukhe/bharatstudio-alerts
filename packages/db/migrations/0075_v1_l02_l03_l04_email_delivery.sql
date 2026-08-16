-- L02/L03/L04: email delivery integration — "a real provider integration
-- (invoice/subscription events, DPDP export delivery, overlay-expiry
-- reminder) — provider credentials remain an external gate per §5, but the
-- integration code is v1-required" ("v1 scope addendum — 2026-08-16").
--
-- Recipient plumbing first: app_users never stored an email address (the
-- Google ID token's email claim was deliberately discarded at
-- auth/google.ts). A DPDP-consistent minimum is added here — the address
-- itself, plus whether Google verified it, nothing else.
--
-- Durable email_outbox, not a fire-and-forget send: an email send must
-- never be the record of a billing fact (invariant #2) and must never be
-- silently dropped (invariant #1's spirit extended to notifications) —
-- this mirrors event_outbox_deliveries's claim/complete shape, simplified
-- (no per-queue fan-out, no lease token — a single maintenance-job drain
-- with `for update skip locked` is sufficient concurrency safety for a
-- notification channel, unlike accepted payment/alert evidence).
--
-- Of the three required triggers, two are event-driven and wired in this
-- migration (invoice/subscription events, from apply_channel_subscription_
-- state's own transitions; DPDP export delivery, from a new opt-in route).
-- The third — overlay-expiry reminder — is genuinely time-based and has no
-- event to hook; it ships as a new maintenance job (mirroring
-- overlay-sessions) whose schedule stays disabled, per the non-negotiable
-- invariant that schedules/Cloud Tasks remain off until private targets/
-- IAM/monitoring/retries/staging evidence are recorded. The integration
-- code is complete and ready to enable; enabling the schedule is not this
-- migration's job.

alter table public.app_users add column email text;
alter table public.app_users add column email_verified boolean not null default false;

-- Recipient capture at sign-in. Postgres treats a changed argument count as
-- a distinct overload rather than a true replace, so the old 7-argument
-- signature is dropped explicitly first (matching this codebase's existing
-- pattern — see 0027/0062's own drop-then-recreate — for any function
-- whose signature needs to change) rather than left behind unused.
drop function if exists app_private.create_user_session(uuid, text, text, text, text, timestamptz, uuid);

create or replace function app_private.create_user_session(
  target_user_id uuid,
  target_external_subject text,
  target_display_name text,
  target_token_hash text,
  target_device_label text,
  target_expires_at timestamptz,
  target_session_id uuid,
  target_email text default null,
  target_email_verified boolean default false
)
returns table (user_id uuid, session_id uuid, expires_at timestamptz)
language sql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
  with upserted_user as (
    insert into public.app_users (id, external_subject, display_name, email, email_verified, created_at, updated_at)
    values (target_user_id, target_external_subject, target_display_name, target_email, target_email_verified, current_timestamp, current_timestamp)
    on conflict (external_subject) do update
      set display_name = coalesce(excluded.display_name, app_users.display_name),
          -- A verified email replaces whatever's on file; an unverified
          -- claim never overwrites an already-verified address.
          email = case when excluded.email_verified or app_users.email is null then coalesce(excluded.email, app_users.email) else app_users.email end,
          email_verified = app_users.email_verified or excluded.email_verified,
          updated_at = current_timestamp
    returning id
  ), inserted_session as (
    insert into public.user_sessions (id, user_id, token_hash, device_label, created_at, last_seen_at, expires_at)
    select target_session_id, upserted_user.id, target_token_hash, target_device_label,
           current_timestamp, current_timestamp, target_expires_at
      from upserted_user
    returning user_id, id, expires_at
  )
  select inserted_session.user_id, inserted_session.id, inserted_session.expires_at
    from inserted_session
$$;

revoke execute on function app_private.create_user_session(uuid, text, text, text, text, timestamptz, uuid, text, boolean) from public;
grant execute on function app_private.create_user_session(uuid, text, text, text, text, timestamptz, uuid, text, boolean) to bsa_app;

create table public.email_outbox (
  id uuid primary key,
  kind text not null check (kind in ('invoice_subscription_event', 'dpdp_export_delivery', 'overlay_expiry_reminder')),
  recipient_user_id uuid not null references public.app_users(id),
  channel_id uuid references public.channels(id),
  payload jsonb not null,
  status text not null check (status in ('pending', 'sending', 'sent', 'failed', 'disabled')) default 'pending',
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_error text,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  sent_at timestamptz
);

create index email_outbox_claim_idx on public.email_outbox (status, created_at asc);

alter table public.email_outbox enable row level security;
revoke all on public.email_outbox from public;
revoke all on public.email_outbox from bsa_app;
revoke all on public.email_outbox from bsa_payment;

-- Overlay-expiry reminder tracking — idempotency for the maintenance job
-- (never queue the same reminder twice for the same session).
alter table public.overlay_sessions add column expiry_reminder_sent_at timestamptz;

-- Enqueues one email_outbox row. Not exposed directly to any client role —
-- only called from other security-definer functions (the subscription
-- state transition, the DPDP export route's backing function, and the
-- overlay-expiry maintenance job), each of which owns its own recipient/
-- payload construction.
create or replace function app_private.enqueue_email(
  target_id uuid,
  target_kind text,
  target_recipient_user_id uuid,
  target_channel_id uuid,
  target_payload jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if target_kind not in ('invoice_subscription_event', 'dpdp_export_delivery', 'overlay_expiry_reminder') then
    raise exception 'invalid email kind: %', target_kind using errcode = '22023';
  end if;
  insert into public.email_outbox (id, kind, recipient_user_id, channel_id, payload, status, created_at, updated_at)
  values (target_id, target_kind, target_recipient_user_id, target_channel_id, target_payload, 'pending', current_timestamp, current_timestamp);
end
$$;

-- Claims up to target_limit pending emails for sending — `for update skip
-- locked` is sufficient concurrency safety across API replicas draining
-- the same outbox concurrently; there is no per-row lease/expiry because a
-- claimed-but-crashed row is completed back to 'pending' by nothing
-- automatic yet (matching this codebase's existing outbox-recover
-- maintenance job pattern for other outboxes — a future addendum, not
-- invented speculatively here).
create or replace function app_private.claim_pending_emails(
  target_limit integer
)
returns table (
  id uuid,
  kind text,
  recipient_user_id uuid,
  recipient_email text,
  recipient_email_verified boolean,
  channel_id uuid,
  payload jsonb,
  attempt_count integer
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  return query
    update public.email_outbox outbox
       set status = 'sending', updated_at = current_timestamp
      from public.app_users recipient
     where outbox.recipient_user_id = recipient.id
       and outbox.id in (
         select claimable.id
           from public.email_outbox claimable
          where claimable.status = 'pending'
          order by claimable.created_at asc
          limit greatest(least(coalesce(target_limit, 25), 100), 1)
            for update of claimable skip locked
       )
    returning outbox.id, outbox.kind, outbox.recipient_user_id, recipient.email, recipient.email_verified,
              outbox.channel_id, outbox.payload, outbox.attempt_count;
end
$$;

-- Marks a claimed email's terminal (or retryable) outcome. 'disabled' is
-- for a recipient with no verified email on file — a real, expected
-- outcome (not every app_users row has one yet), not a failure to retry.
create or replace function app_private.complete_email_outbox_entry(
  target_id uuid,
  target_status text,
  target_error text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if target_status not in ('sent', 'failed', 'disabled', 'pending') then
    raise exception 'invalid email outbox completion status: %', target_status using errcode = '22023';
  end if;
  update public.email_outbox
     set status = target_status,
         last_error = target_error,
         attempt_count = case when target_status = 'failed' then attempt_count + 1 else attempt_count end,
         sent_at = case when target_status = 'sent' then current_timestamp else sent_at end,
         updated_at = current_timestamp
   where id = target_id
     and status = 'sending';
  return found;
end
$$;

revoke execute on function app_private.enqueue_email(uuid, text, uuid, uuid, jsonb) from public;
revoke execute on function app_private.claim_pending_emails(integer) from public;
revoke execute on function app_private.complete_email_outbox_entry(uuid, text, text) from public;
grant execute on function app_private.claim_pending_emails(integer) to bsa_app;
grant execute on function app_private.complete_email_outbox_entry(uuid, text, text) to bsa_app;
-- enqueue_email is intentionally NOT granted directly to bsa_app or
-- bsa_payment — every caller goes through a purpose-built function below
-- that owns its own recipient resolution and payload shape, so a route
-- can never enqueue an arbitrary email kind/payload.

-- Hook into the billing state transition. Reuses the launch authority's
-- already-decided notification-worthy moments: a subscription becoming
-- active, past_due (grace period begins) or cancelled.
create or replace function app_private.enqueue_invoice_subscription_email(
  target_channel_id uuid,
  target_status text,
  target_tier text,
  target_recurring_price_paise bigint,
  target_next_renewal_at timestamptz,
  target_grace_until timestamptz
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  owner_id uuid;
begin
  select channel.owner_user_id into owner_id from public.channels channel where channel.id = target_channel_id;
  if owner_id is null then
    return; -- channel not found is not this function's concern to raise on
  end if;
  perform app_private.enqueue_email(
    gen_random_uuid(), 'invoice_subscription_event', owner_id, target_channel_id,
    jsonb_build_object(
      'status', target_status, 'tier', target_tier, 'recurringPricePaise', target_recurring_price_paise,
      'nextRenewalAt', target_next_renewal_at, 'graceUntil', target_grace_until
    )
  );
end
$$;

revoke execute on function app_private.enqueue_invoice_subscription_email(uuid, text, text, bigint, timestamptz, timestamptz) from public;
grant execute on function app_private.enqueue_invoice_subscription_email(uuid, text, text, bigint, timestamptz, timestamptz) to bsa_payment;

-- Opt-in DPDP export delivery — additive to the existing synchronous
-- GET /v1/me/export (unchanged), not a replacement for it.
create or replace function app_private.enqueue_dpdp_export_email(
  target_user_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if target_user_id <> app_private.current_user_id() then
    raise exception 'actor mismatch' using errcode = '42501';
  end if;
  perform app_private.enqueue_email(gen_random_uuid(), 'dpdp_export_delivery', target_user_id, null, '{}'::jsonb);
end
$$;

revoke execute on function app_private.enqueue_dpdp_export_email(uuid) from public;
grant execute on function app_private.enqueue_dpdp_export_email(uuid) to bsa_app;

alter table public.maintenance_runs
  drop constraint if exists maintenance_runs_job_check;

alter table public.maintenance_runs
  add constraint maintenance_runs_job_check
  check (job in (
    'payment-reconcile', 'refund-reconcile', 'outbox-recover',
    'overlay-sessions', 'event-archive', 'audit-archive', 'overlay-expiry-reminder'
  ));

-- Overlay-expiry reminder maintenance job — new job name, added to the
-- same accept_maintenance_run(job, idempotency_key, window) two-phase
-- protocol 0016 established (accept -> run_<job>_maintenance(run_id)),
-- disabled schedule (this migration ships the integration code only;
-- enabling the schedule is a separate, later decision per the
-- non-negotiable invariant). Idempotent at two levels: the maintenance-run
-- ledger (0016's own idempotency_key mechanism) and per-session via
-- expiry_reminder_sent_at, so re-running never double-queues a reminder.
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
    'overlay-sessions', 'event-archive', 'audit-archive', 'overlay-expiry-reminder'
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

create or replace function app_private.run_overlay_expiry_reminder_maintenance(target_run_id uuid)
returns table (run_id uuid, job text, status text, queued_count integer)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  run_record public.maintenance_runs%rowtype;
  reminder_count integer := 0;
  session_row record;
begin
  select *
    into run_record
    from public.maintenance_runs
   where id = target_run_id
   for update;

  if not found then
    raise exception 'maintenance run not found';
  end if;
  if run_record.job <> 'overlay-expiry-reminder' then
    raise exception 'maintenance run is not an overlay-expiry-reminder job';
  end if;
  if run_record.status = 'completed' then
    return query select run_record.id, run_record.job, 'already_completed'::text, 0;
    return;
  end if;

  for session_row in
    select overlay.id, overlay.channel_id, overlay.expires_at, channel.owner_user_id
      from public.overlay_sessions overlay
      join public.channels channel on channel.id = overlay.channel_id
     where overlay.revoked_at is null
       and overlay.expiry_reminder_sent_at is null
       and overlay.expires_at between current_timestamp and current_timestamp + interval '7 days'
     limit 500
  loop
    perform app_private.enqueue_email(
      gen_random_uuid(), 'overlay_expiry_reminder', session_row.owner_user_id, session_row.channel_id,
      jsonb_build_object('overlaySessionId', session_row.id, 'expiresAt', session_row.expires_at)
    );
    update public.overlay_sessions set expiry_reminder_sent_at = current_timestamp where id = session_row.id;
    reminder_count := reminder_count + 1;
  end loop;

  update public.maintenance_runs
     set status = 'completed', completed_at = current_timestamp
   where id = run_record.id;

  return query select run_record.id, run_record.job, 'completed'::text, reminder_count;
end
$$;

revoke execute on function app_private.run_overlay_expiry_reminder_maintenance(uuid) from public;
grant execute on function app_private.run_overlay_expiry_reminder_maintenance(uuid) to bsa_app;

-- apply_channel_subscription_state, redefined a third time (0048 -> 0070 ->
-- here) to enqueue an invoice/subscription-event email on every status
-- transition — active, past_due (grace period begins) and cancelled — in
-- addition to 0070's existing entitlement-publish/downgrade-enforcement
-- behaviour, which is otherwise unchanged.
create or replace function app_private.apply_channel_subscription_state(
  target_channel_id uuid,
  target_environment text,
  target_provider_account_ref text,
  target_provider_subscription_id text,
  target_tier text,
  target_billing_interval text,
  target_price_paise bigint,
  target_status text,
  target_auto_renew boolean,
  target_period_start timestamptz,
  target_period_end timestamptz,
  target_next_renewal_at timestamptz,
  target_event_at timestamptz
)
returns table (
  result text,
  subscription_id uuid,
  channel_id uuid,
  tier text,
  status text,
  recurring_price_paise bigint,
  price_source text,
  price_protected_until timestamptz,
  grace_until timestamptz
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  current_row public.channel_subscriptions%rowtype;
  previous_cancelled boolean;
  new_id uuid;
  next_protection timestamptz;
  next_grace timestamptz;
  next_price_source text;
begin
  if target_environment not in ('test', 'live')
     or target_tier not in ('pro', 'creator', 'studio')
     or target_billing_interval not in ('monthly', 'annual')
     or target_status not in ('active', 'past_due', 'cancelled')
     or target_provider_account_ref = ''
     or target_provider_subscription_id = ''
     or target_event_at is null
     or target_period_end <= target_period_start then
    raise exception 'invalid subscription state' using errcode = '22023';
  end if;

  if target_price_paise <> (case target_tier
      when 'pro' then 19900
      when 'creator' then 39900
      when 'studio' then 49900
    end) then
    raise exception 'subscription price does not match approved tier' using errcode = '22023';
  end if;

  select * into current_row
    from public.channel_subscriptions
   where provider = 'razorpay'
     and environment = target_environment
     and provider_subscription_id = target_provider_subscription_id
   for update;

  if found and target_event_at <= current_row.last_provider_event_at then
    return query select
      'stale'::text, current_row.id, current_row.channel_id, current_row.tier,
      current_row.status, current_row.recurring_price_paise,
      current_row.price_source, current_row.price_protected_until,
      current_row.grace_until;
    return;
  end if;

  if found then
    if current_row.channel_id <> target_channel_id
       or current_row.provider_account_ref <> target_provider_account_ref then
      raise exception 'subscription channel/account mismatch' using errcode = '23514';
    end if;
    if current_row.recurring_price_paise <> target_price_paise
       or current_row.tier <> target_tier
       or current_row.billing_interval <> target_billing_interval then
      raise exception 'subscription price or plan changed without a new subscription' using errcode = '23514';
    end if;

    next_protection := current_row.price_protected_until;
    next_grace := current_row.grace_until;
    next_price_source := current_row.price_source;
    if target_status = 'past_due' then
      next_grace := greatest(coalesce(next_grace, target_period_end + interval '30 days'), target_period_end + interval '30 days');
    elsif target_status = 'cancelled' then
      next_protection := least(coalesce(next_protection, target_event_at), target_event_at);
      next_grace := null;
    elsif target_status = 'active' then
      next_grace := null;
    end if;

    update public.channel_subscriptions
       set status = target_status,
           auto_renew = target_auto_renew,
           current_period_start = target_period_start,
           current_period_end = target_period_end,
           next_renewal_at = target_next_renewal_at,
           price_protected_until = next_protection,
           grace_until = next_grace,
           cancelled_at = case when target_status = 'cancelled' then coalesce(cancelled_at, target_event_at) else cancelled_at end,
           last_provider_event_at = target_event_at,
           updated_at = current_timestamp
     where id = current_row.id
     returning * into current_row;

    if target_status = 'active' then
      perform app_private.publish_active_individual_entitlement(
        current_row.channel_id, current_row.tier, current_row.provider_subscription_id,
        current_row.billing_interval, current_row.recurring_price_paise,
        current_row.current_period_start
      );
    elsif target_status = 'cancelled' then
      perform app_private.publish_free_entitlement(current_row.channel_id, target_event_at);
    end if;
    perform app_private.enqueue_invoice_subscription_email(
      current_row.channel_id, target_status, current_row.tier, current_row.recurring_price_paise,
      current_row.next_renewal_at, current_row.grace_until
    );

    return query select
      'updated'::text, current_row.id, current_row.channel_id, current_row.tier,
      current_row.status, current_row.recurring_price_paise,
      current_row.price_source, current_row.price_protected_until,
      current_row.grace_until;
    return;
  end if;

  select exists (
    select 1 from public.channel_subscriptions prior
     where prior.channel_id = target_channel_id
       and prior.status = 'cancelled'
  ) into previous_cancelled;
  next_price_source := case when previous_cancelled or target_status = 'cancelled' then 'current' else 'grandfathered' end;
  next_protection := case when previous_cancelled or target_status = 'cancelled' then null else target_period_start + interval '12 months' end;
  next_grace := case when target_status = 'past_due' then target_period_end + interval '30 days' else null end;
  new_id := md5('subscription:' || target_environment || ':' || target_provider_subscription_id)::uuid;

  insert into public.channel_subscriptions (
    id, channel_id, provider, environment, provider_account_ref,
    provider_subscription_id, tier, billing_interval, charged_months,
    service_months, recurring_price_paise, price_source, status, auto_renew,
    current_period_start, current_period_end, next_renewal_at,
    price_protected_until, grace_until, cancelled_at, last_provider_event_at,
    created_at, updated_at
  ) values (
    new_id, target_channel_id, 'razorpay', target_environment,
    target_provider_account_ref, target_provider_subscription_id, target_tier,
    target_billing_interval,
    case when target_billing_interval = 'annual' then 10 else 1 end,
    case when target_billing_interval = 'annual' then 12 else 1 end,
    target_price_paise, next_price_source, target_status, target_auto_renew,
    target_period_start, target_period_end, target_next_renewal_at,
    next_protection, next_grace,
    case when target_status = 'cancelled' then target_event_at else null end,
    target_event_at, current_timestamp, current_timestamp
  ) returning * into current_row;

  if target_status = 'active' then
    perform app_private.publish_active_individual_entitlement(
      current_row.channel_id, current_row.tier, current_row.provider_subscription_id,
      current_row.billing_interval, current_row.recurring_price_paise,
      current_row.current_period_start
    );
  elsif target_status = 'cancelled' then
    perform app_private.publish_free_entitlement(current_row.channel_id, target_event_at);
  end if;
  perform app_private.enqueue_invoice_subscription_email(
    current_row.channel_id, target_status, current_row.tier, current_row.recurring_price_paise,
    current_row.next_renewal_at, current_row.grace_until
  );

  return query select
    'created'::text, current_row.id, current_row.channel_id, current_row.tier,
    current_row.status, current_row.recurring_price_paise,
    current_row.price_source, current_row.price_protected_until,
    current_row.grace_until;
end
$$;
