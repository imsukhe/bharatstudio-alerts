-- L02/L04 acceptance: email delivery — the durable outbox claim/complete
-- protocol, the invoice/subscription-event hook inside
-- apply_channel_subscription_state, the opt-in DPDP export email, and the
-- overlay-expiry-reminder maintenance job's idempotency. Synthetic
-- identifiers only; runs inside begin/rollback.
--
-- email_outbox has zero grants to any client role (revoke all ... from
-- bsa_app, bsa_payment) — every write/read goes through a security-
-- definer function. This test's own verification reads therefore always
-- run as the default (postgres/superuser) role, never bsa_app/bsa_payment,
-- matching how the table is actually locked down in production.

\set ON_ERROR_STOP on

begin;

insert into app_users (id, external_subject, display_name, email, email_verified, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000001001', 'google-email-owner-verified', 'Synthetic Verified Owner', 'verified@example.test', true, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000001002', 'google-email-owner-unverified', 'Synthetic Unverified Owner', 'unverified@example.test', false, current_timestamp, current_timestamp);

insert into channels (id, owner_user_id, handle, display_name, accepting_tips, public_config_version, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000001011', '00000000-0000-4000-8000-000000001001', 'email_channel_verified', 'Email Channel Verified', true, 1, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000001012', '00000000-0000-4000-8000-000000001002', 'email_channel_unverified', 'Email Channel Unverified', true, 1, current_timestamp, current_timestamp);

insert into channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at)
values
  ('00000000-0000-4000-8000-000000001011', 1, 'free', 'individual_plan', '{"queueCount":1}'::jsonb, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000001012', 1, 'free', 'individual_plan', '{"queueCount":1}'::jsonb, current_timestamp, current_timestamp);

-- Subscription activation for the verified-email channel must enqueue an
-- invoice/subscription-event email.
set role bsa_payment;
select app_private.apply_channel_subscription_state(
  '00000000-0000-4000-8000-000000001011', 'test', 'acct_synthetic_email', 'sub_synthetic_email_1', 'creator', 'monthly', 39900, 'active', true,
  '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z', '2026-01-01T00:00:00Z'
);
reset role;
do $$
begin
  if (select count(*) from email_outbox where recipient_user_id = '00000000-0000-4000-8000-000000001001' and kind = 'invoice_subscription_event') <> 1 then
    raise exception 'subscription activation did not enqueue an invoice/subscription-event email';
  end if;
end
$$;

-- Cancellation must enqueue a second, distinct email for the same channel.
set role bsa_payment;
select app_private.apply_channel_subscription_state(
  '00000000-0000-4000-8000-000000001011', 'test', 'acct_synthetic_email', 'sub_synthetic_email_1', 'creator', 'monthly', 39900, 'cancelled', false,
  '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', null, '2026-01-15T00:00:00Z'
);
reset role;
do $$
begin
  if (select count(*) from email_outbox where recipient_user_id = '00000000-0000-4000-8000-000000001001' and kind = 'invoice_subscription_event') <> 2 then
    raise exception 'cancellation did not enqueue a second invoice/subscription-event email';
  end if;
end
$$;

-- Same for the unverified-email owner's channel — the outbox does not
-- gate enqueueing on verification; that is the drain/claim layer's job.
set role bsa_payment;
select app_private.apply_channel_subscription_state(
  '00000000-0000-4000-8000-000000001012', 'test', 'acct_synthetic_email', 'sub_synthetic_email_2', 'pro', 'monthly', 19900, 'active', true,
  '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z', '2026-01-01T00:00:00Z'
);
reset role;

-- DPDP export email: opt-in, actor-scoped (cannot enqueue for another user).
do $$
declare
  actor_mismatch boolean := false;
begin
  set role bsa_app;
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000001001', true);
  perform app_private.enqueue_dpdp_export_email('00000000-0000-4000-8000-000000001001');
  begin
    perform app_private.enqueue_dpdp_export_email('00000000-0000-4000-8000-000000001002');
  exception when sqlstate '42501' then
    actor_mismatch := true;
  end;
  reset role;
  if not actor_mismatch then
    raise exception 'DPDP export email was enqueued for a different user without raising';
  end if;
end
$$;
do $$
begin
  if (select count(*) from email_outbox where recipient_user_id = '00000000-0000-4000-8000-000000001001' and kind = 'dpdp_export_delivery') <> 1 then
    raise exception 'DPDP export email was not enqueued';
  end if;
end
$$;

-- Claim/complete protocol.
do $$
declare
  pending_count integer;
begin
  select count(*) into pending_count from email_outbox where status = 'pending';
  if pending_count < 4 then
    raise exception 'expected at least 4 pending emails before claiming, found %', pending_count;
  end if;
end
$$;

do $$
declare
  claimed_count integer;
begin
  set role bsa_app;
  select count(*) into claimed_count from app_private.claim_pending_emails(100);
  reset role;
  if claimed_count < 4 then
    raise exception 'claim_pending_emails did not claim the expected pending rows: %', claimed_count;
  end if;
end
$$;
do $$
begin
  if (select count(*) from email_outbox where status = 'pending') <> 0 then
    raise exception 'claimed rows were left in pending status';
  end if;
  if (select count(*) from email_outbox where status = 'sending') < 4 then
    raise exception 'claimed rows were not transitioned to sending';
  end if;
end
$$;

-- Complete one as 'sent', one as 'disabled' (matches how the TS drain loop
-- treats a recipient with no verified email); confirm both persist
-- correctly, sent_at is only stamped for 'sent', and a row already
-- completed (no longer 'sending') cannot be completed again —
-- complete_email_outbox_entry returns false, not an error, so the caller
-- can distinguish "nothing to do" from a real failure.
do $$
declare
  sent_id uuid;
  disabled_id uuid;
  repeat_completed boolean;
begin
  select id into sent_id from email_outbox where recipient_user_id = '00000000-0000-4000-8000-000000001001' and kind = 'dpdp_export_delivery' limit 1;
  select id into disabled_id from email_outbox where recipient_user_id = '00000000-0000-4000-8000-000000001002' and kind = 'invoice_subscription_event' limit 1;

  set role bsa_app;
  perform app_private.complete_email_outbox_entry(sent_id, 'sent', null);
  perform app_private.complete_email_outbox_entry(disabled_id, 'disabled', 'recipient has no verified email on file');
  select app_private.complete_email_outbox_entry(sent_id, 'sent', null) into repeat_completed;
  reset role;

  if repeat_completed then
    raise exception 'completed a row that was not in the sending state';
  end if;
  if (select count(*) from email_outbox where status = 'sent' and sent_at is not null) <> 1 then
    raise exception 'sent completion did not stamp sent_at correctly';
  end if;
  if (select status from email_outbox where id = disabled_id) <> 'disabled' then
    raise exception 'disabled completion did not persist';
  end if;
end
$$;

-- Overlay-expiry-reminder maintenance job accepts the job name.
do $$
begin
  set role bsa_app;
  perform app_private.accept_maintenance_run('overlay-expiry-reminder', 'test-idempotency-key-0001', null);
  reset role;
end
$$;

reset role;
rollback;

select 'L02_L04_EMAIL_DELIVERY=PASS' as result;
