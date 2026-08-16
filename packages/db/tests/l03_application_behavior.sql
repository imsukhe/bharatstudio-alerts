-- L03 application migration behavioral proof.
-- Executed by run-l03-application-behavior.sh in a disposable PostgreSQL 16.
-- Synthetic identifiers only; no provider or production data is permitted.

\set ON_ERROR_STOP on

insert into app_users (id, external_subject, display_name, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000000001', 'google-a', 'Synthetic A', current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000000002', 'google-b', 'Synthetic B', current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000000003', 'google-admin', 'Synthetic Admin', current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000000004', 'google-operator', 'Synthetic Operator', current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000000005', 'google-moderator', 'Synthetic Moderator', current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000000006', 'google-viewer', 'Synthetic Viewer', current_timestamp, current_timestamp);

insert into channels (id, owner_user_id, handle, display_name, accepting_tips, public_config_version, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001', 'synthetic_a', 'Synthetic A Channel', true, 1, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000002', 'synthetic_b', 'Synthetic B Channel', true, 1, current_timestamp, current_timestamp);

insert into channel_memberships (channel_id, user_id, role, created_at)
values
  ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001', 'owner', current_timestamp),
  ('00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000002', 'owner', current_timestamp),
  ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000003', 'admin', current_timestamp),
  ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000004', 'operator', current_timestamp),
  ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000005', 'moderator', current_timestamp),
  ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000006', 'viewer', current_timestamp);

insert into channel_configs (channel_id, version, values, effective_at, created_at)
values
  ('00000000-0000-4000-8000-000000000011', 1, '{}'::jsonb, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000000012', 1, '{}'::jsonb, current_timestamp, current_timestamp);

insert into audit_events (id, channel_id, actor_user_id, action, target_type, target_id, metadata, created_at)
values (
  '00000000-0000-4000-8000-000000000201',
  '00000000-0000-4000-8000-000000000011',
  '00000000-0000-4000-8000-000000000001',
  'synthetic.archive_candidate',
  'test',
  'archive-candidate-201',
  '{"synthetic":true}',
  current_timestamp
);

do $$
declare
  archive_result text;
  restored_result text;
  archived_id uuid;
  digest text;
begin
  if has_function_privilege('public', 'app_private.archive_operational_record(text, uuid)', 'EXECUTE')
     or has_function_privilege('public', 'app_private.restore_operational_record(uuid)', 'EXECUTE') then
    raise exception 'archive transfer functions must not be executable by PUBLIC';
  end if;
  if has_table_privilege('bsa_alert_worker', 'public.audit_events', 'DELETE')
     or has_table_privilege('bsa_alert_worker', 'public.event_processing_attempts', 'DELETE')
     or has_table_privilege('bsa_alert_worker', 'public.archive_records', 'UPDATE')
     or has_table_privilege('bsa_alert_worker', 'public.archive_records', 'DELETE') then
    raise exception 'runtime worker must not have direct archive-transfer mutation privileges';
  end if;
  if has_table_privilege('bsa_archive_owner', 'public.audit_events', 'DELETE')
     or has_table_privilege('bsa_archive_owner', 'public.event_processing_attempts', 'DELETE')
     or has_table_privilege('bsa_archive_owner', 'public.archive_records', 'UPDATE')
     or has_table_privilege('bsa_archive_owner', 'public.archive_records', 'DELETE')
     or not has_table_privilege('bsa_archive_owner', 'public.audit_events', 'UPDATE')
     or not has_table_privilege('bsa_archive_owner', 'public.archive_records', 'INSERT') then
    raise exception 'soft-archive owner privileges are unsafe or incomplete';
  end if;
  if (select proowner::regrole::text from pg_proc
      where oid = 'app_private.archive_operational_record(text, uuid)'::regprocedure) <> 'bsa_archive_owner'
     or (select proowner::regrole::text from pg_proc
      where oid = 'app_private.restore_operational_record(uuid)'::regprocedure) <> 'bsa_archive_owner' then
    raise exception 'archive transfer functions must be owned by the isolated archive owner';
  end if;

  set role bsa_alert_worker;
  select result, archive_id, record_digest
    into archive_result, archived_id, digest
    from app_private.archive_operational_record(
      'audit_events', '00000000-0000-4000-8000-000000000201'
    );
  if archive_result <> 'archived' or archived_id is null or digest is null then
    raise exception 'soft archive did not return verified result';
  end if;
  reset role;

  if not exists (
    select 1 from audit_events
     where id = '00000000-0000-4000-8000-000000000201'
       and archived_at is not null
       and archived_by = 'bsa_alert_worker'
  ) then
    raise exception 'soft archive did not retain and mark the source row';
  end if;
  if (select count(*) from archive_records where id = archived_id) <> 1 then
    raise exception 'archive relocation did not preserve one complete destination row';
  end if;

  set role bsa_alert_worker;
  select result into restored_result
    from app_private.restore_operational_record(archived_id);
  reset role;
  if restored_result <> 'restored' then
    raise exception 'archive restore did not clear the soft archive marker';
  end if;
  if (select count(*) from audit_events where id = '00000000-0000-4000-8000-000000000201') <> 1 then
    raise exception 'archive restore source row is incomplete';
  end if;
  if (select archived_at from audit_events where id = '00000000-0000-4000-8000-000000000201') is not null then
    raise exception 'archive restore left the source row hidden';
  end if;

  set role bsa_alert_worker;
  select result into archive_result
    from app_private.archive_operational_record(
      'audit_events', '00000000-0000-4000-8000-000000000201'
    );
  reset role;
  if archive_result <> 'archived' then
    raise exception 'repeat archive did not verify and soft-archive the restored row';
  end if;
exception when others then
  reset role;
  raise;
end
$$;

-- Subscription pricing is server-authoritative. A protected renewal keeps
-- the stored price, a past-due transition creates only the bounded grace
-- window, cancellation ends protection, and a later subscription is priced
-- as current rather than inheriting the cancelled subscription's protection.
do $$
declare
  state_result text;
  state_price bigint;
  state_source text;
  state_protected timestamptz;
  state_grace timestamptz;
  billing_tier text;
  billing_price bigint;
  billing_state text;
  billing_source text;
  annual_entitlement_versions bigint;
begin
  begin
    set role bsa_payment;
    perform app_private.apply_channel_subscription_state(
      '00000000-0000-4000-8000-000000000011', 'test', 'acct_synthetic_platform',
      'sub_synthetic_invalid_annual_1', 'creator', 'annual', 49900, 'active', true,
      '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', '2027-01-01T00:00:00Z',
      '2026-01-01T00:00:00Z'
    );
    reset role;
    raise exception 'annual subscription accepted a price for the wrong tier';
  exception when sqlstate '22023' then
    reset role;
  end;

  set role bsa_payment;
  select result, price_source, price_protected_until
    into state_result, state_source, state_protected
    from app_private.apply_channel_subscription_state(
      '00000000-0000-4000-8000-000000000012', 'test', 'acct_synthetic_platform',
      'sub_synthetic_prestart_cancel_1', 'creator', 'monthly', 39900, 'cancelled', false,
      '2027-01-01T00:00:00Z', '2027-02-01T00:00:00Z', null,
      '2026-12-15T00:00:00Z'
    );
  reset role;
  if state_result <> 'created' or state_source <> 'current' or state_protected is not null then
    raise exception 'first-observed cancelled subscription received protection';
  end if;

  set role bsa_payment;
  select result, recurring_price_paise, price_source, price_protected_until, grace_until
    into state_result, state_price, state_source, state_protected, state_grace
    from app_private.apply_channel_subscription_state(
      '00000000-0000-4000-8000-000000000011', 'test', 'acct_synthetic_platform',
      'sub_synthetic_annual_1', 'creator', 'annual', 39900, 'active', true,
      '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', '2027-01-01T00:00:00Z',
      '2026-01-01T00:00:00Z'
    );
  reset role;
  if state_result <> 'created' or state_price <> 39900 or state_source <> 'grandfathered'
     or state_protected <> '2027-01-01T00:00:00Z'::timestamptz or state_grace is not null then
    raise exception 'initial subscription price protection is incorrect';
  end if;

  set role bsa_payment;
  select result, recurring_price_paise, grace_until
    into state_result, state_price, state_grace
    from app_private.apply_channel_subscription_state(
      '00000000-0000-4000-8000-000000000011', 'test', 'acct_synthetic_platform',
      'sub_synthetic_annual_1', 'creator', 'annual', 39900, 'past_due', true,
      '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', null,
      '2027-01-02T00:00:00Z'
    );
  reset role;
  if state_result <> 'updated' or state_price <> 39900
     or state_grace <> '2027-01-31T00:00:00Z'::timestamptz then
    raise exception 'past-due grace or stored price is incorrect';
  end if;

  set role bsa_payment;
  select result into state_result
    from app_private.apply_channel_subscription_state(
      '00000000-0000-4000-8000-000000000011', 'test', 'acct_synthetic_platform',
      'sub_synthetic_annual_1', 'creator', 'annual', 39900, 'past_due', true,
      '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', null,
      '2027-01-02T00:00:00Z'
    );
  reset role;
  if state_result <> 'stale' then
    raise exception 'equal-timestamp subscription replay was not ignored';
  end if;

  set role bsa_payment;
  select result into state_result
    from app_private.apply_channel_subscription_state(
      '00000000-0000-4000-8000-000000000011', 'test', 'acct_synthetic_platform',
      'sub_synthetic_annual_1', 'creator', 'annual', 39900, 'active', true,
      '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', '2027-01-01T00:00:00Z',
      '2026-01-01T00:00:00Z'
    );
  reset role;
  if state_result <> 'stale' then
    raise exception 'stale subscription event was not ignored';
  end if;

  -- A later active reconciliation for the same subscription must refresh the
  -- subscription projection without publishing a second entitlement version.
  set role bsa_payment;
  select result into state_result
    from app_private.apply_channel_subscription_state(
      '00000000-0000-4000-8000-000000000011', 'test', 'acct_synthetic_platform',
      'sub_synthetic_annual_1', 'creator', 'annual', 39900, 'active', true,
      '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', '2027-01-01T00:00:00Z',
      '2027-01-02T12:00:00Z'
    );
  reset role;
  if state_result <> 'updated' then
    raise exception 'later active reconciliation did not update the subscription projection';
  end if;

  set role bsa_payment;
  select result, price_protected_until, grace_until
    into state_result, state_protected, state_grace
    from app_private.apply_channel_subscription_state(
      '00000000-0000-4000-8000-000000000011', 'test', 'acct_synthetic_platform',
      'sub_synthetic_annual_1', 'creator', 'annual', 39900, 'cancelled', false,
      '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', null,
      '2027-01-03T00:00:00Z'
    );
  reset role;
  if state_result <> 'updated' or state_protected is null
     or state_protected > '2027-01-03T00:00:00Z'::timestamptz
     or state_grace is not null then
    raise exception 'cancellation did not end price protection: protected %, grace %', state_protected, state_grace;
  end if;

  set role bsa_payment;
  select result, price_source, price_protected_until
    into state_result, state_source, state_protected
    from app_private.apply_channel_subscription_state(
      '00000000-0000-4000-8000-000000000011', 'test', 'acct_synthetic_platform',
      'sub_synthetic_rejoin_1', 'creator', 'monthly', 39900, 'active', true,
      '2027-02-01T00:00:00Z', '2027-03-01T00:00:00Z', '2027-03-01T00:00:00Z',
      '2027-02-01T00:00:00Z'
    );
  reset role;
  if state_result <> 'created' or state_source <> 'current' or state_protected is not null then
    raise exception 'rejoin incorrectly inherited grandfathered protection';
  end if;

  -- A late event for the cancelled predecessor must not hide the newer
  -- active subscription from the billing projection.
  set role bsa_payment;
  perform app_private.apply_channel_subscription_state(
    '00000000-0000-4000-8000-000000000011', 'test', 'acct_synthetic_platform',
    'sub_synthetic_annual_1', 'creator', 'annual', 39900, 'cancelled', false,
    '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', null,
    '2027-02-02T00:00:00Z'
  );
  reset role;

  set role bsa_app;
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000001', true);
  select tier, monthly_price_paise, renewal_state, price_source
    into billing_tier, billing_price, billing_state, billing_source
    from app_private.get_billing_view('00000000-0000-4000-8000-000000000011');
  reset role;
  if billing_tier <> 'creator' or billing_price <> 39900
     or billing_state <> 'active' or billing_source <> 'current' then
    raise exception 'billing projection does not use the current stored subscription';
  end if;

  select count(*) into annual_entitlement_versions
    from channel_entitlement_versions
   where channel_id = '00000000-0000-4000-8000-000000000011'
     and values ->> 'subscriptionId' = 'sub_synthetic_annual_1';
  if annual_entitlement_versions <> 1 then
    raise exception 'active subscription reconciliation published duplicate entitlement versions: %', annual_entitlement_versions;
  end if;
exception when others then
  reset role;
  raise;
end
$$;

-- Subscription webhook projection is link-first and fail-closed. The
-- provider event cannot select its channel or tier; only the server-created
-- link can authorize the billing projection.
insert into payment_accounts (id, channel_id, provider, environment, connected_account_ref, status, created_at, updated_at)
values ('00000000-0000-4000-8000-000000000042', '00000000-0000-4000-8000-000000000012', 'razorpay', 'test', 'acct_synthetic_platform', 'active', current_timestamp, current_timestamp);

insert into platform_payment_accounts (provider, environment, provider_account_ref, status, created_at, updated_at)
values ('razorpay', 'test', 'acct_bsa_platform', 'active', current_timestamp, current_timestamp);

do $$
declare
  link_result text;
  duplicate_result boolean;
  quarantined_result boolean;
  delivery_result text;
  projected_status text;
  projected_tier text;
begin
  set role bsa_payment;
  select app_private.register_channel_subscription_link(
    '00000000-0000-4000-8000-000000000012', 'test', 'acct_synthetic_platform',
    'sub_synthetic_webhook_1', 'plan_creator_monthly', 'creator', 'monthly', 39900
  ) into link_result;
  reset role;
  if link_result <> 'created' then
    raise exception 'subscription link was not created: %', link_result;
  end if;

  set role bsa_payment;
  select duplicate, quarantined, delivery_status
    into duplicate_result, quarantined_result, delivery_result
    from app_private.record_verified_subscription_webhook(
      '00000000-0000-4000-8000-000000000191', 'test', 'acct_synthetic_platform',
      'subscription-event-synthetic-1', 'subscription-hash-synthetic-1',
      '2027-01-02T00:00:00Z', '2027-01-02T00:00:00Z',
      '{"event":"subscription.activated","entityType":"subscription","entityId":"sub_synthetic_webhook_1","planId":"plan_creator_monthly","status":"active","currentStart":1798761600,"currentEnd":1830297600,"chargeAt":1830297600}'::jsonb
    );
  reset role;
  if duplicate_result or quarantined_result or delivery_result <> 'processed' then
    raise exception 'linked subscription webhook was not processed: duplicate %, quarantined %, status %', duplicate_result, quarantined_result, delivery_result;
  end if;

  set role bsa_payment;
  select duplicate, quarantined, delivery_status
    into duplicate_result, quarantined_result, delivery_result
    from app_private.record_verified_subscription_webhook(
      '00000000-0000-4000-8000-000000000193', 'test', 'acct_synthetic_platform',
      'subscription-event-synthetic-unknown', 'subscription-hash-synthetic-unknown',
      '2027-01-02T00:00:00Z', '2027-01-02T00:00:00Z',
      '{"event":"subscription.activated","entityType":"subscription","entityId":"sub_synthetic_unknown","planId":"plan_creator_monthly","status":"active","currentStart":1798761600,"currentEnd":1830297600,"chargeAt":1830297600}'::jsonb
    );
  reset role;
  if duplicate_result or not quarantined_result or delivery_result <> 'quarantined' then
    raise exception 'unknown subscription link was not quarantined';
  end if;

  set role bsa_payment;
  select duplicate, quarantined, delivery_status
    into duplicate_result, quarantined_result, delivery_result
    from app_private.record_verified_subscription_webhook(
      '00000000-0000-4000-8000-000000000194', 'test', 'acct_synthetic_platform',
      'subscription-event-synthetic-authenticated', 'subscription-hash-synthetic-authenticated',
      '2027-01-02T00:00:00Z', '2027-01-02T00:00:00Z',
      '{"event":"subscription.authenticated","entityType":"subscription","entityId":"sub_synthetic_webhook_1","planId":"plan_creator_monthly","status":"authenticated","currentStart":0,"currentEnd":0,"chargeAt":0}'::jsonb
    );
  reset role;
  if duplicate_result or not quarantined_result or delivery_result <> 'quarantined' then
    raise exception 'incomplete authenticated subscription was not quarantined';
  end if;

  set role bsa_payment;
  select duplicate, quarantined, delivery_status
    into duplicate_result, quarantined_result, delivery_result
    from app_private.record_verified_subscription_webhook(
      '00000000-0000-4000-8000-000000000195', 'test', 'acct_synthetic_platform',
      'subscription-event-synthetic-plan-mismatch', 'subscription-hash-synthetic-plan-mismatch',
      '2027-01-02T00:00:00Z', '2027-01-02T00:00:00Z',
      '{"event":"subscription.activated","entityType":"subscription","entityId":"sub_synthetic_webhook_1","planId":"plan_other","status":"active","currentStart":1798761600,"currentEnd":1830297600,"chargeAt":1830297600}'::jsonb
    );
  reset role;
  if duplicate_result or not quarantined_result or delivery_result <> 'quarantined' then
    raise exception 'subscription plan mismatch was not quarantined';
  end if;

  set role bsa_payment;
  select duplicate, quarantined, delivery_status
    into duplicate_result, quarantined_result, delivery_result
    from app_private.record_verified_subscription_webhook(
      '00000000-0000-4000-8000-000000000192', 'test', 'acct_synthetic_platform',
      'subscription-event-synthetic-1', 'subscription-hash-synthetic-1-retry',
      '2027-01-03T00:00:00Z', '2027-01-03T00:00:00Z',
      '{"event":"subscription.activated","entityType":"subscription","entityId":"sub_synthetic_webhook_1","planId":"plan_creator_monthly","status":"active","currentStart":1798761600,"currentEnd":1830297600,"chargeAt":1830297600}'::jsonb
    );
  reset role;
  if not duplicate_result or quarantined_result or delivery_result <> 'duplicate' then
    raise exception 'duplicate subscription webhook was not suppressed';
  end if;

  select status, tier into projected_status, projected_tier
    from channel_subscriptions
   where provider_subscription_id = 'sub_synthetic_webhook_1';
  if projected_status <> 'active' or projected_tier <> 'creator' then
    raise exception 'linked subscription did not project active creator state';
  end if;
exception when others then
  reset role;
  raise;
end
$$;

do $$
declare
  link_result text;
  duplicate_result boolean;
  quarantined_result boolean;
  delivery_result text;
  projected_account text;
begin
  set role bsa_payment;
  select app_private.register_channel_subscription_link(
    '00000000-0000-4000-8000-000000000011', 'test', 'platform', 'acct_bsa_platform',
    'sub_platform_webhook_1', 'plan_creator_monthly', 'creator', 'monthly', 39900
  ) into link_result;
  reset role;
  if link_result <> 'created' then
    raise exception 'platform subscription link was not created: %', link_result;
  end if;

  set role bsa_payment;
  select duplicate, quarantined, delivery_status
    into duplicate_result, quarantined_result, delivery_result
    from app_private.record_verified_subscription_webhook(
      '00000000-0000-4000-8000-000000000196', 'test', 'acct_bsa_platform',
      'subscription-event-platform-1', 'subscription-hash-platform-1',
      '2027-01-03T00:00:00Z', '2027-01-03T00:00:00Z',
      '{"event":"subscription.activated","entityType":"subscription","entityId":"sub_platform_webhook_1","planId":"plan_creator_monthly","status":"active","currentStart":1798848000,"currentEnd":1830384000,"chargeAt":1830384000}'::jsonb
    );
  reset role;
  if duplicate_result or quarantined_result or delivery_result <> 'processed' then
    raise exception 'platform subscription webhook was not processed';
  end if;

  select provider_account_ref into projected_account
    from channel_subscriptions
   where provider_subscription_id = 'sub_platform_webhook_1';
  if projected_account <> 'acct_bsa_platform' then
    raise exception 'platform subscription projected the wrong account: %', projected_account;
  end if;

  update platform_payment_accounts
     set status = 'revoked', updated_at = current_timestamp
   where provider = 'razorpay'
     and environment = 'test'
     and provider_account_ref = 'acct_bsa_platform';

  begin
    set role bsa_payment;
    perform app_private.register_channel_subscription_link(
      '00000000-0000-4000-8000-000000000011', 'test', 'platform', 'acct_bsa_platform',
      'sub_platform_revoked', 'plan_creator_monthly', 'creator', 'monthly', 39900
    );
    reset role;
    raise exception 'revoked platform account accepted a subscription link';
  exception when others then
    reset role;
    if sqlstate <> '42501' then
      raise;
    end if;
  end;

  update platform_payment_accounts
     set status = 'active', updated_at = current_timestamp
   where provider = 'razorpay'
     and environment = 'test'
     and provider_account_ref = 'acct_bsa_platform';
exception when others then
  reset role;
  raise;
end
$$;

do $$
declare
  first_id uuid;
  replay_id uuid;
  claimed_status text;
  attached_status text;
  linked_status text;
  attached_subscription text;
  claim_token uuid := '00000000-0000-4000-8000-000000000511';
  early_intent_id uuid;
  early_claim_token uuid := '00000000-0000-4000-8000-000000000512';
  early_duplicate boolean;
  early_quarantined boolean;
  early_delivery_status text;
  early_projected_status text;
  denied boolean;
begin
  set role bsa_payment;
  select id, status into first_id, claimed_status
    from app_private.create_subscription_creation_intent(
      '00000000-0000-4000-8000-000000000501',
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000011',
      'test', 'subscription-idempotency-001', 'platform',
      'acct_bsa_platform', 'plan_creator_monthly', 'creator', 'monthly', 39900
    );
  reset role;
  if first_id <> '00000000-0000-4000-8000-000000000501' or claimed_status <> 'requested' then
    raise exception 'subscription creation intent was not created in requested state';
  end if;

  -- The private payment service is not an authorization authority. Even a
  -- valid bsa_payment caller must not create an intent for a user/channel
  -- membership it does not own or administer.
  denied := false;
  begin
    set role bsa_payment;
    perform app_private.create_subscription_creation_intent(
      '00000000-0000-4000-8000-000000000503',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000011',
      'test', 'subscription-auth-user-mismatch', 'platform',
      'acct_bsa_platform', 'plan_creator_monthly', 'creator', 'monthly', 39900
    );
    reset role;
  exception when others then
    reset role;
    if sqlstate <> '42501' then
      raise;
    end if;
    denied := true;
  end;
  if not denied then
    raise exception 'subscription creation accepted a non-member user';
  end if;

  denied := false;
  begin
    set role bsa_payment;
    perform app_private.create_subscription_creation_intent(
      '00000000-0000-4000-8000-000000000504',
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000012',
      'test', 'subscription-auth-channel-mismatch', 'platform',
      'acct_bsa_platform', 'plan_creator_monthly', 'creator', 'monthly', 39900
    );
    reset role;
  exception when others then
    reset role;
    if sqlstate <> '42501' then
      raise;
    end if;
    denied := true;
  end;
  if not denied then
    raise exception 'subscription creation accepted a channel outside the user membership';
  end if;

  -- A retry with a different local UUID returns the original immutable intent.
  set role bsa_payment;
  select id into replay_id
    from app_private.create_subscription_creation_intent(
      '00000000-0000-4000-8000-000000000502',
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000011',
      'test', 'subscription-idempotency-001', 'platform',
      'acct_bsa_platform', 'plan_creator_monthly', 'creator', 'monthly', 39900
    );
  reset role;
  if replay_id <> first_id then
    raise exception 'subscription idempotency returned a second intent';
  end if;

  set role bsa_payment;
  select status into claimed_status
    from app_private.claim_subscription_provider_creation(
      first_id, claim_token, current_timestamp + interval '5 minutes'
    );
  reset role;
  if claimed_status <> 'provider_pending' then
    raise exception 'subscription provider claim did not enter pending state: %', claimed_status;
  end if;

  set role bsa_payment;
  select status, provider_subscription_id into attached_status, attached_subscription
    from app_private.attach_subscription_provider(
      first_id, claim_token, 'sub_creation_intent_1', 'created', 'https://rzp.io/i/synthetic', current_timestamp
    );
  reset role;
  if attached_status <> 'provider_created' or attached_subscription <> 'sub_creation_intent_1' then
    raise exception 'subscription provider identity was not durably attached';
  end if;

  set role bsa_payment;
  select status into linked_status
    from app_private.link_subscription_creation_intent(first_id);
  reset role;
  if linked_status <> 'linked' then
    raise exception 'subscription creation intent was not linked: %', linked_status;
  end if;

  select provider_subscription_id into attached_subscription
    from channel_subscription_links
   where provider_subscription_id = 'sub_creation_intent_1';
  if attached_subscription <> 'sub_creation_intent_1' then
    raise exception 'linked subscription row is missing';
  end if;

  -- A later link retry is idempotent and does not create another provider link.
  set role bsa_payment;
  select status into linked_status
    from app_private.link_subscription_creation_intent(first_id);
  reset role;
  if linked_status <> 'linked' then
    raise exception 'subscription link retry was not idempotent';
  end if;

  -- A signed event may arrive before link registration. It is quarantined,
  -- then the exact event can be replayed after the local link is repaired.
  set role bsa_payment;
  select id into early_intent_id
    from app_private.create_subscription_creation_intent(
      '00000000-0000-4000-8000-000000000503',
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000011',
      'test', 'subscription-idempotency-early-01', 'platform',
      'acct_bsa_platform', 'plan_creator_monthly', 'creator', 'monthly', 39900
    );
  select status into claimed_status
    from app_private.claim_subscription_provider_creation(
      early_intent_id, early_claim_token, current_timestamp + interval '5 minutes'
    );
  select status into attached_status
    from app_private.attach_subscription_provider(
      early_intent_id, early_claim_token, 'sub_creation_early_1', 'created', 'https://rzp.io/i/early', current_timestamp
    );
  reset role;
  if claimed_status <> 'provider_pending' or attached_status <> 'provider_created' then
    raise exception 'early-webhook intent did not reach provider-created state';
  end if;

  set role bsa_payment;
  select duplicate, quarantined, delivery_status
    into early_duplicate, early_quarantined, early_delivery_status
    from app_private.record_verified_subscription_webhook(
      '00000000-0000-4000-8000-000000000701', 'test', 'acct_bsa_platform',
      'subscription-event-early-1', 'subscription-hash-early-1',
      current_timestamp, current_timestamp,
      '{"event":"subscription.activated","entityType":"subscription","entityId":"sub_creation_early_1","planId":"plan_creator_monthly","status":"active","currentStart":1798848000,"currentEnd":1830384000,"chargeAt":1830384000}'::jsonb
    );
  reset role;
  if early_duplicate or not early_quarantined or early_delivery_status <> 'quarantined' then
    raise exception 'early subscription webhook was not durably quarantined';
  end if;

  set role bsa_payment;
  select status into linked_status
    from app_private.link_subscription_creation_intent(early_intent_id);
  reset role;
  if linked_status <> 'linked' then
    raise exception 'early subscription intent could not be repaired';
  end if;

  set role bsa_payment;
  select duplicate, quarantined, delivery_status
    into early_duplicate, early_quarantined, early_delivery_status
    from app_private.record_verified_subscription_webhook(
      '00000000-0000-4000-8000-000000000702', 'test', 'acct_bsa_platform',
      'subscription-event-early-1', 'subscription-hash-early-1',
      current_timestamp, current_timestamp,
      '{"event":"subscription.activated","entityType":"subscription","entityId":"sub_creation_early_1","planId":"plan_creator_monthly","status":"active","currentStart":1798848000,"currentEnd":1830384000,"chargeAt":1830384000}'::jsonb
    );
  reset role;
  if early_duplicate or early_quarantined or early_delivery_status <> 'processed' then
    raise exception 'quarantined subscription webhook was not replayable after link repair';
  end if;

  select status into early_projected_status
    from channel_subscriptions
   where provider_subscription_id = 'sub_creation_early_1';
  if early_projected_status <> 'active' then
    raise exception 'replayed subscription webhook did not project active state';
  end if;
exception when others then
  reset role;
  raise;
end
$$;

-- Version is computed, not hardcoded: 0070's downgrade-enforcement
-- migration made every 'cancelled' apply_channel_subscription_state call
-- above also publish a free-entitlement version, so the exact version
-- number this channel has reached by this point in the fixture sequence is
-- no longer a fixed constant.
insert into channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at)
select '00000000-0000-4000-8000-000000000011',
       coalesce(max(version), 0) + 1,
       'creator', 'individual_plan', '{"test":true}'::jsonb, current_timestamp, current_timestamp
  from channel_entitlement_versions
 where channel_id = '00000000-0000-4000-8000-000000000011';

insert into alert_queues (id, channel_id, name, created_at, updated_at)
values ('00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000011', 'Synthetic default', current_timestamp, current_timestamp);

insert into alert_queues (id, channel_id, name, created_at, updated_at)
values ('00000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-000000000011', 'Synthetic secondary', current_timestamp, current_timestamp);

insert into payment_accounts (id, channel_id, provider, environment, connected_account_ref, status, created_at, updated_at)
values ('00000000-0000-4000-8000-000000000041', '00000000-0000-4000-8000-000000000011', 'razorpay', 'test', 'acct_synthetic_a', 'active', current_timestamp, current_timestamp);

insert into queue_bindings (id, channel_id, queue_id, source_type, source_id, allow_duplicates, priority, override_values, created_at)
values
  ('00000000-0000-4000-8000-000000000031', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000021', 'payment', 'source-a', true, 20, '{"style":"primary"}', current_timestamp),
  ('00000000-0000-4000-8000-000000000032', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000022', 'payment', 'source-a', true, 10, '{"style":"secondary"}', current_timestamp),
  ('00000000-0000-4000-8000-000000000033', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000021', 'payment', 'pay_synthetic_1', true, 20, '{"style":"payment"}', current_timestamp),
  ('00000000-0000-4000-8000-000000000034', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000022', 'payment', 'pay_synthetic_1', true, 10, '{"style":"payment-secondary"}', current_timestamp);

begin;
set local role bsa_alert_worker;
select * from app_private.resolve_queue_bindings('00000000-0000-4000-8000-000000000011', 'payment', 'source-a');
commit;

do $$
begin
  if (select count(*) from app_private.resolve_queue_bindings('00000000-0000-4000-8000-000000000011', 'payment', 'source-a')) <> 2 then
    raise exception 'L31/L32 source binding resolution failed';
  end if;
end
$$;

-- A creator must be able to route a payment before Razorpay has assigned its
-- provider payment ID. The reserved default source is used only when no
-- exact source binding exists; the source-a assertion above proves exact
-- bindings retain precedence over defaults.
do $$
begin
  if (select count(*) from app_private.resolve_queue_bindings('00000000-0000-4000-8000-000000000011', 'payment', 'pay_not_created_yet')) <> 2 then
    raise exception 'channel-default payment bindings are not available for new payments';
  end if;
end
$$;

-- The overlay must receive the versioned configuration used at acceptance,
-- not whatever the creator edits later.
update channel_configs
   set values = '{"minimumTipPaise":2500,"defaultDisplaySeconds":12,"defaultStyle":"celebration","display":{"anchor":"top_right","scale":1.25},"queue":{"mode":"pills","stackLimit":3}}'::jsonb
 where channel_id = '00000000-0000-4000-8000-000000000011'
   and version = 1;

do $$
begin
  if (select minimum_tip_paise from app_private.get_public_channel('demo_creator')) <> 2500 then
    raise exception 'public channel projection did not expose the configured tip minimum';
  end if;
end
$$;

begin;
set local role bsa_app;
select * from app_private.accept_maintenance_run('outbox-recover', 'synthetic-maintenance-001', '2026-08-14T10:00Z');
select * from app_private.accept_maintenance_run('outbox-recover', 'synthetic-maintenance-001', '2026-08-14T10:00Z');
commit;

begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', true);
insert into overlay_sessions (id, channel_id, token_fingerprint, expires_at, created_at)
values
  ('00000000-0000-4000-8000-000000000092', '00000000-0000-4000-8000-000000000011', 'fingerprint-expired', current_timestamp - interval '1 minute', current_timestamp),
  ('00000000-0000-4000-8000-000000000093', '00000000-0000-4000-8000-000000000011', 'fingerprint-live', current_timestamp + interval '1 hour', current_timestamp);
select * from app_private.accept_maintenance_run('overlay-sessions', 'overlay-maintenance-001', '2026-08-14T10:00Z');
select * from app_private.run_overlay_session_maintenance(md5('maintenance:overlay-sessions:overlay-maintenance-001')::uuid);
select * from app_private.run_overlay_session_maintenance(md5('maintenance:overlay-sessions:overlay-maintenance-001')::uuid);
commit;

do $$
begin
  if (select revoked_at from overlay_sessions where id = '00000000-0000-4000-8000-000000000092') is null
     or (select revoked_at from overlay_sessions where id = '00000000-0000-4000-8000-000000000093') is not null
     or (select status from maintenance_runs where job = 'overlay-sessions' and idempotency_key = 'overlay-maintenance-001') <> 'completed' then
    raise exception 'L06 overlay-session maintenance did not complete transactionally';
  end if;
end
$$;

do $$
begin
  if (select count(*) from maintenance_runs where job = 'outbox-recover' and idempotency_key = 'synthetic-maintenance-001') <> 1
     or (select count(*) from maintenance_runs where job = 'outbox-recover' and status = 'accepted') <> 1 then
    raise exception 'L06 maintenance run idempotency failed';
  end if;
end
$$;

begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', true);
select * from app_private.create_user_session(
  '00000000-0000-4000-8000-000000000001', 'google-a', 'Synthetic A',
  'hash-session-a', 'integration-test', current_timestamp + interval '1 hour',
  '00000000-0000-4000-8000-000000000071'
);
select * from app_private.lookup_session('hash-session-a');
commit;

do $$
begin
  if (select count(*) from user_sessions where id = '00000000-0000-4000-8000-000000000071') <> 1 then
    raise exception 'L03 session creation failed';
  end if;
end
$$;

begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', true);
select * from app_private.create_channel(
  '00000000-0000-4000-8000-000000000013',
  '00000000-0000-4000-8000-000000000001', 'created_by_test', 'Created by test'
);
commit;

do $$
begin
  if (select count(*) from channel_memberships where channel_id = '00000000-0000-4000-8000-000000000013' and role = 'owner') <> 1 then
    raise exception 'L03 channel membership creation failed';
  end if;
  if (select count(*) from channel_configs where channel_id = '00000000-0000-4000-8000-000000000013' and version = 1) <> 1 then
    raise exception 'L03 initial channel config missing';
  end if;
  if (select count(*) from channel_entitlement_versions where channel_id = '00000000-0000-4000-8000-000000000013' and tier = 'free') <> 1 then
    raise exception 'L03 initial entitlement missing';
  end if;
  if (select count(*) from alert_queues where channel_id = '00000000-0000-4000-8000-000000000013' and name = 'Main alerts' and closed_at is null) <> 1 then
    raise exception 'L03 default alert queue missing';
  end if;
end
$$;

-- The default payment route is system-owned and must remain available for a
-- new provider payment. Binding identity is also immutable at the SQL
-- boundary, not only through the API's narrower update contract.
begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', true);
do $$
declare
  default_binding_id uuid;
begin
  select id into default_binding_id
    from queue_bindings
   where channel_id = '00000000-0000-4000-8000-000000000013'
     and source_type = 'payment'
     and source_id = '__channel_default__'
     and closed_at is null;
  if default_binding_id is null then
    raise exception 'new channel default payment binding missing';
  end if;

  begin
    update queue_bindings set closed_at = current_timestamp where id = default_binding_id;
    raise exception 'default payment binding was closed';
  exception when others then
    if sqlerrm <> 'default payment binding cannot be closed' then
      raise;
    end if;
  end;

  begin
    update queue_bindings set source_id = 'rewritten-source' where id = default_binding_id;
    raise exception 'queue binding identity was rewritten';
  exception when others then
    if sqlerrm <> 'queue binding identity is immutable' then
      raise;
    end if;
  end;
end
$$;
commit;

begin;
set local role bsa_app;
do $$
begin
  begin
    perform * from app_private.create_payment_order_intent(
      '00000000-0000-4000-8000-000000000113',
      '00000000-0000-4000-8000-000000000011',
      'test', 'tip-idempotency-below-minimum', 'receipt-tip-below-minimum', 1000, 'Synthetic Donor', 'Below minimum', true,
      current_timestamp + interval '15 minutes'
    );
    raise exception 'channel minimum did not reject a below-minimum order';
  exception when others then
    if sqlstate <> '22023' or sqlerrm not like '%below channel minimum%' then
      raise;
    end if;
  end;
end
$$;
commit;

begin;
set local role bsa_app;
do $$
begin
  begin
    perform * from app_private.create_payment_order_intent(
      '00000000-0000-4000-8000-000000000114',
      '00000000-0000-4000-8000-000000000011',
      'test', 'tip-expiry-too-long', 'receipt-expiry-too-long', 1000, 'Synthetic Donor', 'Too long', true,
      current_timestamp + interval '16 minutes'
    );
    raise exception 'checkout expiry cap accepted an overlong local intent';
  exception when others then
    if sqlstate <> '22023' or sqlerrm <> 'invalid payment order intent' then
      raise;
    end if;
  end;
end
$$;
commit;

begin;
set local role bsa_app;
select * from app_private.create_payment_order_intent(
  '00000000-0000-4000-8000-000000000111',
  '00000000-0000-4000-8000-000000000011',
  'test', 'tip-idempotency-1', 'receipt-tip-1', 5000, 'Synthetic Donor', 'Thanks!', true,
  current_timestamp + interval '15 minutes'
);
select * from app_private.create_payment_order_intent(
  '00000000-0000-4000-8000-000000000112',
  '00000000-0000-4000-8000-000000000011',
  'test', 'tip-idempotency-1', 'receipt-tip-1', 5000, 'Synthetic Donor', 'Thanks!', true,
  current_timestamp + interval '15 minutes'
);
commit;

do $$
begin
  if (select count(*) from payment_order_intents where channel_id = '00000000-0000-4000-8000-000000000011') <> 1 then
    raise exception 'L04 order intent idempotency failed';
  end if;
  if (select status from payment_order_intents where id = '00000000-0000-4000-8000-000000000111') <> 'provider_pending' then
    raise exception 'L04 order intent status was not provider_pending';
  end if;
end
$$;

begin;
set local role bsa_app;
do $$
begin
  perform * from app_private.create_payment_order_intent(
    '00000000-0000-4000-8000-000000000115',
    '00000000-0000-4000-8000-000000000011',
    'test', 'tip-idempotency-mismatch', 'receipt-tip-mismatch', 5000, 'Synthetic Donor', 'Original', true,
    current_timestamp + interval '15 minutes'
  );
  begin
    perform * from app_private.create_payment_order_intent(
      '00000000-0000-4000-8000-000000000116',
      '00000000-0000-4000-8000-000000000011',
      'test', 'tip-idempotency-mismatch', 'receipt-tip-mismatch', 6000, 'Synthetic Donor', 'Changed', true,
      current_timestamp + interval '15 minutes'
    );
    raise exception 'idempotency mismatch was accepted';
  exception when others then
    if sqlstate <> '23505' or sqlerrm not like '%idempotency key reused with different intent%' then
      raise;
    end if;
  end;
end
$$;
commit;

begin;
set local role bsa_app;
do $$
begin
  begin
    perform * from app_private.create_payment_order_intent(
      '00000000-0000-4000-8000-000000000117',
      '00000000-0000-4000-8000-000000000011',
      'test', 'unsafe idempotency key', 'receipt-tip-unsafe', 5000, 'Synthetic Donor', 'Unsafe key', true,
      current_timestamp + interval '15 minutes'
    );
    raise exception 'unsafe idempotency key was accepted';
  exception when others then
    if sqlstate <> '22023' or sqlerrm not like '%invalid payment order intent%' then
      raise;
    end if;
  end;
end
$$;
commit;

do $$
declare
  status text;
  amount bigint;
begin
  select public_status.status, public_status.amount_paise
    into status, amount
    from app_private.get_public_payment_status('00000000-0000-4000-8000-000000000111') public_status;
  if status <> 'provider_pending' or amount <> 5000 then
    raise exception 'public payment status projection was not donor-safe and current';
  end if;
end
$$;

begin;
set local role bsa_app;
select * from app_private.create_payment_order_intent(
  '00000000-0000-4000-8000-000000000112',
  '00000000-0000-4000-8000-000000000011',
  'test', 'tip-idempotency-2', 'receipt-tip-2', 6000, 'Quiet Donor', 'Private tip', false,
  current_timestamp + interval '15 minutes'
);
commit;

do $$
begin
  if (select alert_consent from payment_order_intents where id = '00000000-0000-4000-8000-000000000112') is distinct from false then
    raise exception 'L04 alert consent was not persisted as false';
  end if;
end
$$;

begin;
set local role bsa_payment;
select * from app_private.claim_payment_order_intent(
  '00000000-0000-4000-8000-000000000111',
  '00000000-0000-4000-8000-0000000000b1', current_timestamp + interval '30 seconds'
);
select * from app_private.attach_provider_order(
  '00000000-0000-4000-8000-000000000111',
  '00000000-0000-4000-8000-0000000000b1', 'order_synthetic_1', current_timestamp
);
commit;

begin;
set local role bsa_payment;
select * from app_private.claim_payment_order_intent(
  '00000000-0000-4000-8000-000000000112',
  '00000000-0000-4000-8000-0000000000b2', current_timestamp + interval '30 seconds'
);
select * from app_private.attach_provider_order(
  '00000000-0000-4000-8000-000000000112',
  '00000000-0000-4000-8000-0000000000b2', 'order_synthetic_2', current_timestamp
);
commit;

do $$
begin
  if (select provider_order_id from payment_order_intents where id = '00000000-0000-4000-8000-000000000111') <> 'order_synthetic_1'
     or (select status from payment_order_intents where id = '00000000-0000-4000-8000-000000000111') <> 'provider_created' then
    raise exception 'L04 provider order attachment failed';
  end if;
end
$$;

update payment_order_intents
   set expires_at = current_timestamp - interval '1 second'
 where id = '00000000-0000-4000-8000-000000000111';

begin;
do $$
begin
  if (select count(*) from app_private.list_payment_reconciliation_candidates(20)
      where intent_id = '00000000-0000-4000-8000-000000000111') <> 1 then
    raise exception 'L04 reconciliation candidate listing failed';
  end if;
  if (select count(*) from app_private.expire_payment_order_intent(
      '00000000-0000-4000-8000-000000000111', 'created')) <> 1 then
    raise exception 'L04 unpaid intent expiry failed';
  end if;
  if (select count(*) from app_private.enqueue_payment_recovery(
      '00000000-0000-4000-8000-000000000111', 'order_synthetic_1', current_timestamp)) <> 1 then
    raise exception 'L04 payment recovery enqueue failed';
  end if;
  if (select count(*) from app_private.enqueue_payment_recovery(
      '00000000-0000-4000-8000-000000000111', 'order_synthetic_1', current_timestamp)) <> 1 then
    raise exception 'L04 payment recovery idempotent retry failed';
  end if;
end
$$;
commit;

do $$
begin
  if (select count(*) from reconciliation_work_items
      where kind = 'payment-recovery'
        and idempotency_key = 'razorpay-order:order_synthetic_1') <> 1
     or (select status from payment_order_intents where id = '00000000-0000-4000-8000-000000000111') <> 'expired' then
    raise exception 'L04 reconciliation persistence state failed';
  end if;
end
$$;

begin;
set local role bsa_payment;
select * from app_private.record_verified_payment_webhook(
  '00000000-0000-4000-8000-000000000141',
  'test', 'acct_synthetic_a', 'provider-event-1', 'synthetic-hash-1',
  current_timestamp, current_timestamp,
  '{"event":"payment.captured","entityType":"payment","entityId":"pay_synthetic_1","paymentId":"pay_synthetic_1","orderId":"order_synthetic_1","amountPaise":"5000","currency":"INR","status":"captured"}'::jsonb,
  '00000000-0000-4000-8000-000000000131', null,
  '00000000-0000-4000-8000-000000000151',
  '00000000-0000-4000-8000-000000000161',
  '[{"deliveryId":"00000000-0000-4000-8000-000000000181","queueId":"00000000-0000-4000-8000-000000000021","bindingId":"00000000-0000-4000-8000-000000000033","configSnapshotVersion":"1","deliverySequence":"1","sourcePriority":"20","overrideValues":{"style":"payment"}},{"deliveryId":"00000000-0000-4000-8000-000000000182","queueId":"00000000-0000-4000-8000-000000000022","bindingId":"00000000-0000-4000-8000-000000000034","configSnapshotVersion":"1","deliverySequence":"2","sourcePriority":"10","overrideValues":{"style":"payment-secondary"}}]'::jsonb
);
commit;

do $$
begin
  if (select count(*) from payment_webhook_deliveries where provider_event_id = 'provider-event-1' and processing_status = 'processed') <> 1
     or (select count(*) from payments where provider_payment_id = 'pay_synthetic_1' and status = 'captured') <> 1
     or (select count(*) from alert_events where id = '00000000-0000-4000-8000-000000000151' and payment_id = '00000000-0000-4000-8000-000000000131') <> 1
     or (select trace_id from alert_events where id = '00000000-0000-4000-8000-000000000151') <> 'razorpay:provider-event-1'
     or (select payload ->> 'displayName' from alert_events where id = '00000000-0000-4000-8000-000000000151') <> 'Synthetic Donor'
     or (select payload ->> 'message' from alert_events where id = '00000000-0000-4000-8000-000000000151') <> 'Thanks!'
     or (select count(*) from event_outbox_deliveries where outbox_id = '00000000-0000-4000-8000-000000000161' and status = 'ready') <> 2
     or (select source_priority from event_outbox_deliveries where id = '00000000-0000-4000-8000-000000000181') <> 20
     or (select override_values ->> 'style' from event_outbox_deliveries where id = '00000000-0000-4000-8000-000000000181') <> 'payment' then
    raise exception 'L04 verified webhook atomic financial/outbox write failed';
  end if;
end
$$;

begin;
set local role bsa_payment;
do $$
begin
  begin
    perform * from app_private.record_verified_payment_webhook(
      '00000000-0000-4000-8000-000000000146',
      'test', 'acct_synthetic_a', 'provider event unsafe', 'synthetic-hash-unsafe',
      current_timestamp, current_timestamp,
      '{"event":"payment.captured","entityType":"payment","entityId":"pay_synthetic_1","paymentId":"pay_synthetic_1","orderId":"order_synthetic_1","amountPaise":"5000","currency":"INR","status":"captured"}'::jsonb,
      '00000000-0000-4000-8000-000000000131', null,
      '00000000-0000-4000-8000-000000000156',
      '00000000-0000-4000-8000-000000000166',
      '[]'::jsonb
    );
    raise exception 'L04 unsafe provider event ID was accepted';
  exception when check_violation then
    null;
  end;
end
$$;
commit;

-- L03 role-scoped read proof: financial values are for owner/admin only;
-- operator/moderator retain the alert content needed to operate/moderate;
-- viewer receives status metadata without donor or financial details.
do $$
declare
  history_amount bigint;
  history_currency text;
  history_name text;
  history_message text;
  raw_payment_count integer;
begin
  set role bsa_app;

  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000003', true);
  select gross_amount_paise, currency, display_name, message
    into history_amount, history_currency, history_name, history_message
    from app_private.get_alert_history(
      '00000000-0000-4000-8000-000000000011', null, null, 100
    )
   where event_id = '00000000-0000-4000-8000-000000000151';
  if history_amount <> 5000 or history_currency <> 'INR' or history_name <> 'Synthetic Donor' or history_message <> 'Thanks!' then
    raise exception 'owner/admin history projection lost permitted financial/content fields';
  end if;
  select count(*) into raw_payment_count from payments where id = '00000000-0000-4000-8000-000000000131';
  if raw_payment_count <> 1 then
    raise exception 'owner/admin cannot read the channel payment row';
  end if;

  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000004', true);
  select gross_amount_paise, currency, display_name, message
    into history_amount, history_currency, history_name, history_message
    from app_private.get_alert_history(
      '00000000-0000-4000-8000-000000000011', null, null, 100
    )
   where event_id = '00000000-0000-4000-8000-000000000151';
  if history_amount is not null or history_currency is not null or history_name <> 'Synthetic Donor' or history_message <> 'Thanks!' then
    raise exception 'operator history projection was not minimized';
  end if;
  select count(*) into raw_payment_count from payments where id = '00000000-0000-4000-8000-000000000131';
  if raw_payment_count <> 0 then
    raise exception 'operator can read a raw channel payment row';
  end if;

  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000005', true);
  select gross_amount_paise, currency, display_name, message
    into history_amount, history_currency, history_name, history_message
    from app_private.get_alert_history(
      '00000000-0000-4000-8000-000000000011', null, null, 100
    )
   where event_id = '00000000-0000-4000-8000-000000000151';
  if history_amount is not null or history_currency is not null or history_name is null or history_message is null then
    raise exception 'moderator history projection did not preserve alert content without money';
  end if;
  select count(*) into raw_payment_count from payments where id = '00000000-0000-4000-8000-000000000131';
  if raw_payment_count <> 0 then
    raise exception 'moderator can read a raw channel payment row';
  end if;

  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000006', true);
  select gross_amount_paise, currency, display_name, message
    into history_amount, history_currency, history_name, history_message
    from app_private.get_alert_history(
      '00000000-0000-4000-8000-000000000011', null, null, 100
    )
   where event_id = '00000000-0000-4000-8000-000000000151';
  if history_amount is not null or history_currency is not null or history_name is not null or history_message is not null then
    raise exception 'viewer history projection exposed donor or financial detail';
  end if;
  select count(*) into raw_payment_count from payments where id = '00000000-0000-4000-8000-000000000131';
  if raw_payment_count <> 0 then
    raise exception 'viewer can read a raw channel payment row';
  end if;

  reset role;
exception when others then
  reset role;
  raise;
end
$$;

begin;
set local role bsa_payment;
select * from app_private.record_verified_payment_webhook(
  '00000000-0000-4000-8000-000000000143',
  'test', 'acct_synthetic_a', 'provider-event-1-order-paid', 'synthetic-hash-1-order-paid',
  current_timestamp, current_timestamp,
  '{"event":"order.paid","entityType":"payment","entityId":"pay_synthetic_1","paymentId":"pay_synthetic_1","orderId":"order_synthetic_1","amountPaise":"5000","currency":"INR","status":"captured"}'::jsonb,
  '00000000-0000-4000-8000-000000000131', null,
  '00000000-0000-4000-8000-000000000153',
  '00000000-0000-4000-8000-000000000163',
  '[]'::jsonb
);
commit;

do $$
begin
  if (select count(*) from payment_webhook_deliveries where provider_event_id in ('provider-event-1', 'provider-event-1-order-paid')) <> 2
     or (select count(*) from alert_events where payment_id = '00000000-0000-4000-8000-000000000131') <> 1
     or (select count(*) from event_outbox_deliveries delivery join alert_events event on event.id = delivery.event_id where event.payment_id = '00000000-0000-4000-8000-000000000131') <> 2
     or (select count(*) from payment_webhook_deliveries where provider_event_id = 'provider-event-1-order-paid' and processing_status = 'processed') <> 1 then
    raise exception 'distinct capture webhook IDs created a duplicate payment alert projection';
  end if;
end
$$;

insert into refunds (id, payment_id, provider_refund_id, amount_paise, status, created_at, updated_at)
values ('00000000-0000-4000-8000-000000000191', '00000000-0000-4000-8000-000000000131', 'rfnd_reconcile_1', 1000, 'requested', current_timestamp, current_timestamp);

begin;
set local role bsa_payment;
do $$
begin
  if (select count(*) from app_private.list_refund_reconciliation_candidates(20)
      where refund_id = '00000000-0000-4000-8000-000000000191') <> 1 then
    raise exception 'L04 refund reconciliation candidate listing failed';
  end if;
  if (select count(*) from app_private.apply_refund_reconciliation(
      '00000000-0000-4000-8000-000000000191', 'rfnd_reconcile_1', 'pay_synthetic_1', 1000, 'INR', 'processed')) <> 1 then
    raise exception 'L04 refund reconciliation application failed';
  end if;
end
$$;
commit;

do $$
begin
  if (select status from refunds where id = '00000000-0000-4000-8000-000000000191') <> 'processed'
     or (select status from payments where id = '00000000-0000-4000-8000-000000000131') <> 'partially_refunded' then
    raise exception 'L04 refund reconciliation state failed';
  end if;
end
$$;

begin;
set local role bsa_payment;
select * from app_private.complete_payment_recovery('order_synthetic_1');
commit;

do $$
begin
  if (select status from reconciliation_work_items where kind = 'payment-recovery' and idempotency_key = 'razorpay-order:order_synthetic_1') <> 'completed' then
    raise exception 'L04 payment recovery completion failed';
  end if;
end
$$;

begin;
set local role bsa_payment;
select * from app_private.record_verified_payment_webhook(
  '00000000-0000-4000-8000-000000000144',
  'test', 'acct_synthetic_a', 'provider-event-2', 'synthetic-hash-2',
  current_timestamp, current_timestamp,
  '{"event":"payment.captured","entityType":"payment","entityId":"pay_synthetic_2","paymentId":"pay_synthetic_2","orderId":"order_synthetic_2","amountPaise":"6000","currency":"INR","status":"captured"}'::jsonb,
  '00000000-0000-4000-8000-000000000132', null,
  null, null, '[]'::jsonb
);
commit;

do $$
begin
  if (select count(*) from payment_webhook_deliveries where provider_event_id = 'provider-event-2' and processing_status = 'processed') <> 1
     or (select count(*) from payments where provider_payment_id = 'pay_synthetic_2' and status = 'captured') <> 1
     or (select count(*) from alert_events where payment_id = '00000000-0000-4000-8000-000000000132') <> 0 then
    raise exception 'L04 alert consent false did not suppress alert projection';
  end if;
end
$$;

begin;
set local role bsa_payment;
select * from app_private.record_verified_payment_webhook(
  '00000000-0000-4000-8000-000000000171',
  'test', 'acct_synthetic_a', 'provider-event-refund-2', 'synthetic-hash-refund-2',
  current_timestamp, current_timestamp,
  '{"event":"refund.processed","entityType":"refund","entityId":"rfnd_synthetic_2","paymentId":"pay_synthetic_2","amountPaise":"6000","currency":"INR","status":"processed","refundAmount":"2500"}'::jsonb,
  null, '00000000-0000-4000-8000-000000000172', null, null, '[]'::jsonb
);
commit;

do $$
begin
  if (select status from payments where provider_payment_id = 'pay_synthetic_2') <> 'partially_refunded'
     or (select count(*) from refunds where provider_refund_id = 'rfnd_synthetic_2' and status = 'processed') <> 1 then
    raise exception 'L04 partial refund aggregation failed';
  end if;
end
$$;

begin;
set local role bsa_payment;
select * from app_private.record_verified_payment_webhook(
  '00000000-0000-4000-8000-000000000173',
  'test', 'acct_synthetic_a', 'provider-event-refund-2', 'synthetic-hash-refund-2',
  current_timestamp, current_timestamp,
  '{"event":"refund.processed","entityType":"refund","entityId":"rfnd_synthetic_2","paymentId":"pay_synthetic_2","amountPaise":"6000","currency":"INR","status":"processed","refundAmount":"2500"}'::jsonb,
  null, '00000000-0000-4000-8000-000000000174', null, null, '[]'::jsonb
);
commit;

do $$
begin
  if (select count(*) from refunds where payment_id = '00000000-0000-4000-8000-000000000132') <> 1
     or (select count(*) from payment_webhook_deliveries where provider_event_id = 'provider-event-refund-2') <> 1 then
    raise exception 'L04 duplicate refund webhook applied a second financial effect';
  end if;
end
$$;

begin;
set local role bsa_payment;
select * from app_private.record_verified_payment_webhook(
  '00000000-0000-4000-8000-000000000175',
  'test', 'acct_synthetic_a', 'provider-event-refund-3', 'synthetic-hash-refund-3',
  current_timestamp, current_timestamp,
  '{"event":"refund.processed","entityType":"refund","entityId":"rfnd_synthetic_3","paymentId":"pay_synthetic_2","amountPaise":"6000","currency":"INR","status":"processed","refundAmount":"3500"}'::jsonb,
  null, '00000000-0000-4000-8000-000000000176', null, null, '[]'::jsonb
);
commit;

do $$
begin
  if (select status from payments where provider_payment_id = 'pay_synthetic_2') <> 'refunded'
     or (select coalesce(sum(amount_paise), 0) from refunds where payment_id = '00000000-0000-4000-8000-000000000132' and status = 'processed') <> 6000 then
    raise exception 'L04 final refund aggregation failed';
  end if;
end
$$;

-- A later distinct webhook for an existing provider refund must advance the
-- existing business row rather than being lost behind ON CONFLICT DO NOTHING.
insert into payments (
  id, channel_id, provider, provider_payment_id, provider_order_id,
  gross_amount_paise, currency, status, environment, connected_account_ref,
  created_at, updated_at
)
values (
  '00000000-0000-4000-8000-000000000193',
  '00000000-0000-4000-8000-000000000011',
  'razorpay', 'pay_synthetic_3', 'order_synthetic_3', 4000, 'INR', 'captured',
  'test', 'acct_synthetic_a', current_timestamp, current_timestamp
);

begin;
set local role bsa_payment;
select * from app_private.record_verified_payment_webhook(
  '00000000-0000-4000-8000-0000000001a1',
  'test', 'acct_synthetic_a', 'provider-event-refund-4-created', 'synthetic-hash-refund-4-created',
  current_timestamp, current_timestamp,
  '{"event":"refund.created","entityType":"refund","entityId":"rfnd_synthetic_4","paymentId":"pay_synthetic_3","amountPaise":"4000","currency":"INR","status":"created","refundAmount":"1500"}'::jsonb,
  null, '00000000-0000-4000-8000-000000000194', null, null, '[]'::jsonb
);
commit;

begin;
set local role bsa_payment;
select * from app_private.record_verified_payment_webhook(
  '00000000-0000-4000-8000-0000000001a2',
  'test', 'acct_synthetic_a', 'provider-event-refund-4-processed', 'synthetic-hash-refund-4-processed',
  current_timestamp, current_timestamp,
  '{"event":"refund.processed","entityType":"refund","entityId":"rfnd_synthetic_4","paymentId":"pay_synthetic_3","amountPaise":"4000","currency":"INR","status":"processed","refundAmount":"1500"}'::jsonb,
  null, '00000000-0000-4000-8000-000000000194', null, null, '[]'::jsonb
);
commit;

begin;
set local role bsa_payment;
select * from app_private.record_verified_payment_webhook(
  '00000000-0000-4000-8000-0000000001a3',
  'test', 'acct_synthetic_a', 'provider-event-refund-4-late-failed', 'synthetic-hash-refund-4-late-failed',
  current_timestamp, current_timestamp,
  '{"event":"refund.failed","entityType":"refund","entityId":"rfnd_synthetic_4","paymentId":"pay_synthetic_3","amountPaise":"4000","currency":"INR","status":"failed","refundAmount":"1500"}'::jsonb,
  null, '00000000-0000-4000-8000-000000000194', null, null, '[]'::jsonb
);
commit;

do $$
begin
  if (select status from refunds where provider_refund_id = 'rfnd_synthetic_4') <> 'processed'
     or (select status from payments where provider_payment_id = 'pay_synthetic_3') <> 'partially_refunded'
     or (select count(*) from refunds where provider_refund_id = 'rfnd_synthetic_4') <> 1
     or (select count(*) from payment_webhook_deliveries where entity_id = 'rfnd_synthetic_4') <> 3 then
    raise exception 'L04 later refund webhook status synchronization failed';
  end if;
end
$$;

-- A terminal reversed event can also be the first event seen for a refund;
-- the newly inserted business row must not be left in requested state.
begin;
set local role bsa_payment;
select * from app_private.record_verified_payment_webhook(
  '00000000-0000-4000-8000-0000000001a4',
  'test', 'acct_synthetic_a', 'provider-event-refund-5-reversed', 'synthetic-hash-refund-5-reversed',
  current_timestamp, current_timestamp,
  '{"event":"refund.reversed","entityType":"refund","entityId":"rfnd_synthetic_5","paymentId":"pay_synthetic_3","amountPaise":"4000","currency":"INR","status":"reversed","refundAmount":"500"}'::jsonb,
  null, '00000000-0000-4000-8000-000000000197', null, null, '[]'::jsonb
);
commit;

do $$
begin
  if (select status from refunds where provider_refund_id = 'rfnd_synthetic_5') <> 'reversed'
     or (select status from payments where provider_payment_id = 'pay_synthetic_3') <> 'partially_refunded' then
    raise exception 'L04 first terminal refund webhook synchronization failed';
  end if;
end
$$;

-- Binding edits after acceptance must not rewrite an already-created delivery.
update queue_bindings
   set priority = 99, override_values = '{"style":"edited-after-acceptance"}'::jsonb
 where id = '00000000-0000-4000-8000-000000000033';

do $$
begin
  if (select source_priority from event_outbox_deliveries where id = '00000000-0000-4000-8000-000000000181') <> 20
     or (select override_values ->> 'style' from event_outbox_deliveries where id = '00000000-0000-4000-8000-000000000181') <> 'payment' then
    raise exception 'L31/L32 accepted delivery snapshot changed after binding edit';
  end if;
end
$$;

-- D-2: a second delivery is legal only when every participating binding
-- explicitly opted in. A stale/malformed internal payload must not bypass the
-- consent rule after the first delivery has already been inserted.
insert into queue_bindings (id, channel_id, queue_id, source_type, source_id, allow_duplicates, priority, override_values, created_at)
values
  ('00000000-0000-4000-8000-000000000035', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000021', 'payment', 'guard-only', false, 1, '{}', current_timestamp);

begin;
set local role bsa_payment;
do $$
begin
  begin
    insert into event_outbox_deliveries (
      id, event_id, outbox_id, queue_id, binding_id, source_id,
      config_snapshot_version, delivery_sequence, source_priority, override_values,
      status, attempt_count, created_at, updated_at
    ) values (
      '00000000-0000-4000-8000-000000000185',
      '00000000-0000-4000-8000-000000000151',
      '00000000-0000-4000-8000-000000000161',
      '00000000-0000-4000-8000-000000000021',
      '00000000-0000-4000-8000-000000000035',
      'guard-only', 1, 3, 1, '{}', 'ready', 0, current_timestamp, current_timestamp
    );
    raise exception 'non-consenting duplicate delivery unexpectedly accepted';
  exception when insufficient_privilege then
    null;
  end;
end
$$;
commit;

begin;
set local role bsa_alert_worker;
select * from app_private.claim_event_delivery(
  '00000000-0000-4000-8000-000000000181',
  '00000000-0000-4000-8000-000000000151',
  '00000000-0000-4000-8000-000000000161',
  1, 1,
  '00000000-0000-4000-8000-0000000000c1', current_timestamp + interval '5 minutes'
);
select * from app_private.complete_event_delivery(
  '00000000-0000-4000-8000-000000000181',
  '00000000-0000-4000-8000-0000000000c1', 'displayed'
);
select * from app_private.claim_event_delivery(
  '00000000-0000-4000-8000-000000000182',
  '00000000-0000-4000-8000-000000000151',
  '00000000-0000-4000-8000-000000000161',
  1, 1,
  '00000000-0000-4000-8000-0000000000c2', current_timestamp + interval '5 minutes'
);
select * from app_private.release_event_delivery(
  '00000000-0000-4000-8000-000000000182',
  '00000000-0000-4000-8000-0000000000c2'
);
commit;

do $$
begin
  if (select status from event_outbox_deliveries where id = '00000000-0000-4000-8000-000000000181') <> 'displayed'
     or (select status from event_outbox_deliveries where id = '00000000-0000-4000-8000-000000000182') <> 'ready'
     or (select lease_token from event_outbox_deliveries where id = '00000000-0000-4000-8000-000000000182') is not null
     or (select published_at from event_outbox_deliveries where id = '00000000-0000-4000-8000-000000000182') is null
     or (select count(*) from app_private.list_ready_event_deliveries(100)
          where delivery_id = '00000000-0000-4000-8000-000000000182') <> 0
     or (select status from event_outbox where id = '00000000-0000-4000-8000-000000000161') <> 'pending' then
    raise exception 'L05 publication marker or independent multi-queue release failed';
  end if;
end
$$;

-- L04 dispute webhooks are append-only financial evidence. They may arrive
-- after the payment is known, but they never rewrite the original payment or
-- alert and their status must not regress on out-of-order delivery.
begin;
set local role bsa_payment;
select * from app_private.record_verified_dispute_webhook(
  '00000000-0000-4000-8000-0000000001b1', 'test', 'acct_synthetic_a',
  'provider-dispute-created-1', 'synthetic-dispute-hash-1',
  current_timestamp, current_timestamp,
  '{"event":"payment.dispute.created","entityType":"dispute","entityId":"disp_synthetic_1","paymentId":"pay_synthetic_1","amountPaise":"5000","currency":"INR"}'::jsonb,
  '00000000-0000-4000-8000-0000000001b2'
);
select * from app_private.record_verified_dispute_webhook(
  '00000000-0000-4000-8000-0000000001b3', 'test', 'acct_synthetic_a',
  'provider-dispute-under-review-1', 'synthetic-dispute-hash-2',
  current_timestamp, current_timestamp,
  '{"event":"payment.dispute.under_review","entityType":"dispute","entityId":"disp_synthetic_1","paymentId":"pay_synthetic_1","amountPaise":"5000","currency":"INR"}'::jsonb,
  '00000000-0000-4000-8000-0000000001b4'
);
select * from app_private.record_verified_dispute_webhook(
  '00000000-0000-4000-8000-0000000001b5', 'test', 'acct_synthetic_a',
  'provider-dispute-created-1', 'synthetic-dispute-hash-3',
  current_timestamp, current_timestamp,
  '{"event":"payment.dispute.created","entityType":"dispute","entityId":"disp_synthetic_1","paymentId":"pay_synthetic_1","amountPaise":"5000","currency":"INR"}'::jsonb,
  '00000000-0000-4000-8000-0000000001b6'
);
commit;

do $$
begin
  if (select status from payment_disputes where provider_dispute_id = 'disp_synthetic_1') <> 'under_review'
     or (select payment_id from payment_disputes where provider_dispute_id = 'disp_synthetic_1') <> '00000000-0000-4000-8000-000000000131'::uuid
     or (select count(*) from payment_webhook_deliveries where entity_type = 'dispute' and provider_event_id in ('provider-dispute-created-1', 'provider-dispute-under-review-1')) <> 2 then
    raise exception 'L04 dispute evidence persistence or monotonic status failed';
  end if;
end
$$;

-- L05 queue pause is a hold, never a drop. A task already enqueued before a
-- pause must become a safe no-op, and the same durable row must be claimable
-- after the queue resumes.
begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', true);
update alert_queues
   set is_paused = true
 where id = '00000000-0000-4000-8000-000000000022';
commit;

begin;
set local role bsa_app;
select set_config('app.overlay_session_id', '00000000-0000-4000-8000-000000000093', true);
do $$
begin
  if (select count(*) from app_private.get_overlay_events(
    '00000000-0000-4000-8000-000000000093', null, null, 100)
    where event_id = '00000000-0000-4000-8000-000000000151'
      and payload ->> 'deliveryId' = '00000000-0000-4000-8000-000000000182') <> 0 then
    raise exception 'L05 paused queue leaked a replayable overlay event';
  end if;
end
$$;
commit;

begin;
set local role bsa_alert_worker;
do $$
begin
  if (select count(*) from app_private.list_ready_event_deliveries(100)
       where delivery_id = '00000000-0000-4000-8000-000000000182') <> 0 then
    raise exception 'L05 paused queue remained in ready delivery list';
  end if;
  if (select count(*) from app_private.claim_event_delivery(
    '00000000-0000-4000-8000-000000000182',
    '00000000-0000-4000-8000-000000000151',
    '00000000-0000-4000-8000-000000000161',
    2, 3,
    '00000000-0000-4000-8000-0000000000c4', current_timestamp + interval '5 minutes')) <> 0 then
    raise exception 'L05 paused queue delivery was claimable';
  end if;
end
$$;
commit;

begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', true);
update alert_queues
   set is_paused = false
 where id = '00000000-0000-4000-8000-000000000022';
commit;

begin;
set local role bsa_app;
select set_config('app.overlay_session_id', '00000000-0000-4000-8000-000000000093', true);
do $$
begin
  if (select count(*) from app_private.get_overlay_events(
    '00000000-0000-4000-8000-000000000093', null, null, 100)
    where event_id = '00000000-0000-4000-8000-000000000151'
      and payload ->> 'deliveryId' = '00000000-0000-4000-8000-000000000182') = 0 then
    raise exception 'L05 resumed queue did not expose its durable overlay event';
  end if;
end
$$;
commit;

begin;
set local role bsa_alert_worker;
do $$
begin
  if (select count(*) from app_private.claim_event_delivery(
    '00000000-0000-4000-8000-000000000182',
    '00000000-0000-4000-8000-000000000151',
    '00000000-0000-4000-8000-000000000161',
    2, 3,
    '00000000-0000-4000-8000-0000000000c3', current_timestamp + interval '5 minutes')) <> 0 then
    raise exception 'L05 stale task reclaimed a delivery already published';
  end if;
end
$$;
commit;

do $$
begin
  if (select status from event_outbox_deliveries where id = '00000000-0000-4000-8000-000000000182') <> 'ready'
     or (select status from event_outbox where id = '00000000-0000-4000-8000-000000000161') <> 'pending' then
    raise exception 'L05 outbox projection refresh failed';
  end if;
end
$$;

-- L32 source-specific rate limiting is delay-only. The first delivery consumes
-- the one-per-minute slot; the second remains durable and is delayed with a
-- fresh state version. After the window rolls, the same delivery is claimable.
insert into queue_bindings (id, channel_id, queue_id, source_type, source_id, allow_duplicates, priority, override_values, created_at)
values (
  '00000000-0000-4000-8000-0000000001d1',
  '00000000-0000-4000-8000-000000000011',
  '00000000-0000-4000-8000-000000000021',
  'payment', 'rate-limited-source', true, 1,
  '{"rateLimitPerMinute":1}'::jsonb, current_timestamp
);
insert into alert_events (id, channel_id, payment_id, source_type, source_id, trace_id, config_snapshot_version, payload, created_at)
values
  ('00000000-0000-4000-8000-0000000001d2', '00000000-0000-4000-8000-000000000011', null, 'payment', 'rate-limited-source', 'trace-rate-limit-1', 1, '{"displayName":"Rate One","message":"first"}'::jsonb, current_timestamp),
  ('00000000-0000-4000-8000-0000000001d3', '00000000-0000-4000-8000-000000000011', null, 'payment', 'rate-limited-source', 'trace-rate-limit-2', 1, '{"displayName":"Rate Two","message":"second"}'::jsonb, current_timestamp);
insert into event_outbox (id, event_id, status, available_at, created_at, updated_at)
values
  ('00000000-0000-4000-8000-0000000001d4', '00000000-0000-4000-8000-0000000001d2', 'pending', current_timestamp, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-0000000001d5', '00000000-0000-4000-8000-0000000001d3', 'pending', current_timestamp, current_timestamp, current_timestamp);
insert into event_outbox_deliveries (
  id, event_id, outbox_id, queue_id, binding_id, source_id,
  config_snapshot_version, delivery_sequence, source_priority, override_values,
  status, attempt_count, created_at, updated_at
)
values
  ('00000000-0000-4000-8000-0000000001d6', '00000000-0000-4000-8000-0000000001d2', '00000000-0000-4000-8000-0000000001d4', '00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-0000000001d1', 'rate-limited-source', 1, 1, 1, '{"rateLimitPerMinute":1}'::jsonb, 'ready', 0, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-0000000001d7', '00000000-0000-4000-8000-0000000001d3', '00000000-0000-4000-8000-0000000001d5', '00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-0000000001d1', 'rate-limited-source', 1, 1, 1, '{"rateLimitPerMinute":1}'::jsonb, 'ready', 0, current_timestamp, current_timestamp);

begin;
set local role bsa_alert_worker;
do $$
begin
  if (select count(*) from app_private.claim_event_delivery(
    '00000000-0000-4000-8000-0000000001d6',
    '00000000-0000-4000-8000-0000000001d2',
    '00000000-0000-4000-8000-0000000001d4',
    1, 1, '00000000-0000-4000-8000-0000000001d8', current_timestamp + interval '5 minutes')) <> 1 then
    raise exception 'L32 first rate-limited delivery was not claimed';
  end if;
  if (select count(*) from app_private.claim_event_delivery(
    '00000000-0000-4000-8000-0000000001d7',
    '00000000-0000-4000-8000-0000000001d3',
    '00000000-0000-4000-8000-0000000001d5',
    1, 1, '00000000-0000-4000-8000-0000000001d9', current_timestamp + interval '5 minutes')) <> 0 then
    raise exception 'L32 rate limit did not delay the second delivery';
  end if;
  set local role postgres;
  if (select status from event_outbox_deliveries where id = '00000000-0000-4000-8000-0000000001d7') <> 'ready'
     or (select last_error_code from event_outbox_deliveries where id = '00000000-0000-4000-8000-0000000001d7') <> 'rate_limited'
     or (select state_version from event_outbox_deliveries where id = '00000000-0000-4000-8000-0000000001d7') <> 2
     or (select next_action_at from event_outbox_deliveries where id = '00000000-0000-4000-8000-0000000001d7') is null then
    raise exception 'L32 rate-limited delivery was not durably delayed';
  end if;
  if (select rate_limit_dispatch_count from queue_bindings where id = '00000000-0000-4000-8000-0000000001d1') <> 1 then
    raise exception 'L32 source rate counter was not consumed atomically';
  end if;
  if (select count(*) from app_private.complete_event_delivery(
    '00000000-0000-4000-8000-0000000001d6',
    '00000000-0000-4000-8000-0000000001d8', 'displayed')) <> 1 then
    raise exception 'L32 first rate-limited delivery did not complete';
  end if;
end
$$;
commit;

update queue_bindings
   set rate_limit_window_started_at = current_timestamp - interval '2 minutes'
 where id = '00000000-0000-4000-8000-0000000001d1';
update event_outbox_deliveries
   set next_action_at = current_timestamp - interval '1 second'
 where id = '00000000-0000-4000-8000-0000000001d7';

begin;
set local role bsa_alert_worker;
do $$
begin
  if (select count(*) from app_private.claim_event_delivery(
    '00000000-0000-4000-8000-0000000001d7',
    '00000000-0000-4000-8000-0000000001d3',
    '00000000-0000-4000-8000-0000000001d5',
    1, 2, '00000000-0000-4000-8000-0000000001da', current_timestamp + interval '5 minutes')) <> 1 then
    raise exception 'L32 delayed delivery was not claimable after window rollover';
  end if;
  if (select count(*) from app_private.complete_event_delivery(
    '00000000-0000-4000-8000-0000000001d7',
    '00000000-0000-4000-8000-0000000001da', 'displayed')) <> 1 then
    raise exception 'L32 delayed delivery did not complete';
  end if;
end
$$;
commit;

begin;
set local role bsa_payment;
select * from app_private.record_verified_payment_webhook(
  '00000000-0000-4000-8000-000000000142',
  'test', 'acct_synthetic_a', 'provider-event-refund-1', 'synthetic-hash-refund-1',
  current_timestamp, current_timestamp,
  '{"event":"refund.processed","entityType":"refund","entityId":"rfnd_synthetic_1","paymentId":"pay_synthetic_1","amountPaise":"5000","currency":"INR","status":"processed","refundAmount":"5000"}'::jsonb,
  null, '00000000-0000-4000-8000-000000000132', null, null, '[]'::jsonb
);
commit;

do $$
begin
  if (select count(*) from refunds where provider_refund_id = 'rfnd_synthetic_1' and status = 'processed') <> 1
     or (select status from payments where provider_payment_id = 'pay_synthetic_1') <> 'refunded' then
    raise exception 'L04 refund state transition failed';
  end if;
end
$$;

begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', true);
select * from app_private.create_manual_alert(
  '00000000-0000-4000-8000-000000000051',
  '00000000-0000-4000-8000-000000000061',
  '00000000-0000-4000-8000-000000000011',
  '00000000-0000-4000-8000-000000000001',
  'trace-l03-manual-1', 1, '{"displayName":"Synthetic Viewer","message":"Hello","queueIds":["00000000-0000-4000-8000-000000000021"]}'
);
commit;

do $$
begin
  if (select count(*) from alert_events where id = '00000000-0000-4000-8000-000000000051') <> 1
     or (select count(*) from event_outbox where event_id = '00000000-0000-4000-8000-000000000051' and status = 'pending') <> 1 then
    raise exception 'L03 manual alert/outbox atomic write failed';
  end if;
end
$$;

-- Explicit manual queue selection is not binding-based duplicate routing and
-- must remain able to target more than one queue.
begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', true);
select * from app_private.create_manual_alert(
  '00000000-0000-4000-8000-000000000053',
  '00000000-0000-4000-8000-000000000063',
  '00000000-0000-4000-8000-000000000011',
  '00000000-0000-4000-8000-000000000001',
  'trace-l03-manual-multi-1', 1,
  '{"displayName":"Synthetic Multi","message":"Two explicit queues","queueIds":["00000000-0000-4000-8000-000000000021","00000000-0000-4000-8000-000000000022"]}'
);
commit;

do $$
begin
  if (select count(*) from event_outbox_deliveries where outbox_id = '00000000-0000-4000-8000-000000000063') <> 2 then
    raise exception 'explicit multi-queue manual alert was rejected by binding consent guard';
  end if;
end
$$;

insert into event_outbox_deliveries (id, event_id, outbox_id, queue_id, binding_id, source_id, config_snapshot_version, delivery_sequence, status, attempt_count, created_at, updated_at)
values ('00000000-0000-4000-8000-000000000081', '00000000-0000-4000-8000-000000000051', '00000000-0000-4000-8000-000000000061', '00000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-000000000032', '00000000-0000-4000-8000-000000000051', 1, 1, 'ready', 0, '2026-08-14T10:45:48.527358Z'::timestamptz, '2026-08-14T10:45:48.527358Z'::timestamptz);
begin;
set local role bsa_alert_worker;
do $$
begin
  if (select count(*) from app_private.list_ready_event_deliveries(20)
      where delivery_id = '00000000-0000-4000-8000-000000000081'
        and attempt_number = 1
        and state_version = 1
        and trace_id = 'trace-l03-manual-1') <> 1 then
    raise exception 'L05 ready delivery listing failed';
  end if;
end
$$;
commit;
-- A shared event status must not hide a valid delivery for another queue.
update event_outbox
   set status = 'quarantined', updated_at = current_timestamp
 where id = '00000000-0000-4000-8000-000000000061';

begin;
set local role bsa_alert_worker;
do $$
begin
  if (select count(*) from app_private.claim_event_delivery(
    '00000000-0000-4000-8000-000000000081',
    '00000000-0000-4000-8000-000000000052',
    '00000000-0000-4000-8000-000000000061',
    1, 1,
    '00000000-0000-4000-8000-0000000000af', current_timestamp + interval '5 minutes')) <> 0 then
    raise exception 'L05 mismatched delivery identity was claimable';
  end if;
  if (select count(*) from app_private.claim_event_delivery(
    '00000000-0000-4000-8000-000000000081',
    '00000000-0000-4000-8000-000000000051',
    '00000000-0000-4000-8000-000000000061',
    1, 1,
    '00000000-0000-4000-8000-0000000000a1', current_timestamp + interval '5 minutes')) <> 1 then
    raise exception 'L05 first delivery claim failed';
  end if;
  if (select count(*) from app_private.claim_event_delivery(
    '00000000-0000-4000-8000-000000000081',
    '00000000-0000-4000-8000-000000000051',
    '00000000-0000-4000-8000-000000000061',
    1, 1,
    '00000000-0000-4000-8000-0000000000a2', current_timestamp + interval '5 minutes')) <> 0 then
    raise exception 'L05 duplicate delivery claim unexpectedly acquired active lease';
  end if;
  if (select count(*) from app_private.retry_event_delivery(
    '00000000-0000-4000-8000-000000000081',
    '00000000-0000-4000-8000-0000000000a1', current_timestamp, 'synthetic_tts_timeout')) <> 1 then
    raise exception 'L05 retry transition failed';
  end if;
  if (select count(*) from app_private.claim_event_delivery(
    '00000000-0000-4000-8000-000000000081',
    '00000000-0000-4000-8000-000000000051',
    '00000000-0000-4000-8000-000000000061',
    2, 3,
    '00000000-0000-4000-8000-0000000000a2', current_timestamp + interval '5 minutes')) <> 1 then
    raise exception 'L05 retry reclaim failed';
  end if;
  if (select count(*) from app_private.complete_event_delivery(
    '00000000-0000-4000-8000-000000000081',
    '00000000-0000-4000-8000-0000000000a2', 'acknowledged')) <> 0 then
    raise exception 'L05 invalid ready-to-acknowledged transition was accepted';
  end if;
  if (select count(*) from app_private.complete_event_delivery(
    '00000000-0000-4000-8000-000000000081',
    '00000000-0000-4000-8000-0000000000a2', 'displayed')) <> 1 then
    raise exception 'L05 completion transition failed';
  end if;
  if (select count(*) from app_private.claim_event_delivery(
    '00000000-0000-4000-8000-000000000081',
    '00000000-0000-4000-8000-000000000051',
    '00000000-0000-4000-8000-000000000061',
    3, 5,
    '00000000-0000-4000-8000-0000000000a3', current_timestamp + interval '5 minutes')) <> 0 then
    raise exception 'L05 completed delivery was claimable again';
  end if;
end
$$;
commit;

do $$
begin
  if (select status from event_outbox_deliveries where id = '00000000-0000-4000-8000-000000000081') <> 'displayed'
     or (select attempt_count from event_outbox_deliveries where id = '00000000-0000-4000-8000-000000000081') <> 2
     or (select lease_token from event_outbox_deliveries where id = '00000000-0000-4000-8000-000000000081') is not null then
    raise exception 'L05 delivery lease state was not durable and terminal';
  end if;
end
$$;

begin;
set local role bsa_alert_worker;
select app_private.notify_overlay_wakeup(
  '00000000-0000-4000-8000-000000000011',
  '00000000-0000-4000-8000-000000000051'
);
commit;

begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', true);
select * from app_private.get_alert_history('00000000-0000-4000-8000-000000000011', null, 25);
commit;

begin;
set local role postgres;
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', true);
insert into alert_events (id, channel_id, payment_id, source_type, source_id, trace_id, config_snapshot_version, payload, created_at)
values
  ('00000000-0000-4000-8000-000000000211', '00000000-0000-4000-8000-000000000011', null, 'manual', 'history-tie-211', 'trace-history-211', 1, '{"displayName":"Tie A","message":"same timestamp"}'::jsonb, '2026-08-14T10:00:00Z'),
  ('00000000-0000-4000-8000-000000000212', '00000000-0000-4000-8000-000000000011', null, 'manual', 'history-tie-212', 'trace-history-212', 1, '{"displayName":"Tie B","message":"same timestamp"}'::jsonb, '2026-08-14T10:00:00Z');
insert into event_outbox (id, event_id, status, available_at, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000000213', '00000000-0000-4000-8000-000000000211', 'completed', '2026-08-14T10:00:00Z', '2026-08-14T10:00:00Z', '2026-08-14T10:00:00Z'),
  ('00000000-0000-4000-8000-000000000214', '00000000-0000-4000-8000-000000000212', 'completed', '2026-08-14T10:00:00Z', '2026-08-14T10:00:00Z', '2026-08-14T10:00:00Z');
commit;

do $$
declare
  first_event uuid;
  first_created timestamptz;
  remaining_count integer;
  remaining_event uuid;
begin
  set local role bsa_app;
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000001', true);
  select event_id, created_at
    into first_event, first_created
   from app_private.get_alert_history('00000000-0000-4000-8000-000000000011', null, null, 100)
   where event_id in ('00000000-0000-4000-8000-000000000211', '00000000-0000-4000-8000-000000000212')
   order by created_at desc, event_id desc
   limit 1;
  if first_event <> '00000000-0000-4000-8000-000000000212' then
    raise exception 'history tie-breaker did not order the larger event id first';
  end if;

  select count(*), (array_agg(event_id order by event_id))[1]
    into remaining_count, remaining_event
    from app_private.get_alert_history('00000000-0000-4000-8000-000000000011', first_created, first_event, 100)
   where event_id in ('00000000-0000-4000-8000-000000000211', '00000000-0000-4000-8000-000000000212');
  if remaining_count <> 1 or remaining_event <> '00000000-0000-4000-8000-000000000211' then
    raise exception 'history composite cursor skipped or repeated same-timestamp event';
  end if;
end
$$;

begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', true);
-- Moderation is now a state transition, not an audit-only insert. Approve
-- keeps this projection fixture dispatchable; the dedicated L05 test covers
-- hold/suppress/quiet blocking without deleting the accepted row.
select * from app_private.apply_moderation_action(
  '00000000-0000-4000-8000-000000000051',
  '00000000-0000-4000-8000-000000000011',
  '00000000-0000-4000-8000-000000000001', 'approve', 'integration test'
);
commit;

begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', true);
insert into overlay_sessions (id, channel_id, token_fingerprint, expires_at, created_at)
values ('00000000-0000-4000-8000-000000000091', '00000000-0000-4000-8000-000000000011', 'fingerprint-a', current_timestamp + interval '1 hour', current_timestamp);
insert into companion_commands (id, channel_id, actor_user_id, idempotency_key, action, target_id, status, created_at)
values ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001', 'command-a-001', 'pause_queue', '00000000-0000-4000-8000-000000000021', 'accepted', current_timestamp)
on conflict (channel_id, idempotency_key) do nothing;
insert into companion_commands (id, channel_id, actor_user_id, idempotency_key, action, target_id, status, created_at)
values ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001', 'command-a-001', 'pause_queue', '00000000-0000-4000-8000-000000000021', 'accepted', current_timestamp)
on conflict (channel_id, idempotency_key) do nothing;

-- A Companion test action is a real durable alert, not an accepted no-op.
-- The result event is linked to the idempotent command so a retry cannot
-- create a second alert or delivery.
select * from app_private.create_manual_alert(
  '00000000-0000-4000-8000-000000000221',
  '00000000-0000-4000-8000-000000000222',
  '00000000-0000-4000-8000-000000000011',
  '00000000-0000-4000-8000-000000000001',
  'companion:command-test-001',
  1,
  '{"displayName":"BharatStudio Companion","message":"Companion test alert","queueIds":["00000000-0000-4000-8000-000000000021"]}'::jsonb
);
insert into companion_commands (id, channel_id, actor_user_id, idempotency_key, action, target_id, result_event_id, status, created_at)
values ('00000000-0000-4000-8000-000000000223', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001', 'command-test-001', 'send_test_alert', '00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000221', 'accepted', current_timestamp)
on conflict (channel_id, idempotency_key) do nothing;
insert into companion_commands (id, channel_id, actor_user_id, idempotency_key, action, target_id, result_event_id, status, created_at)
values ('00000000-0000-4000-8000-000000000224', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001', 'command-test-001', 'send_test_alert', '00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000225', 'accepted', current_timestamp)
on conflict (channel_id, idempotency_key) do nothing;
select set_config('app.overlay_session_id', '00000000-0000-4000-8000-000000000091', true);
select * from app_private.lookup_overlay_token('00000000-0000-4000-8000-000000000091', 'fingerprint-a');
select * from app_private.get_overlay_events('00000000-0000-4000-8000-000000000091', null, null, 50);
do $$
begin
  if not exists (
       select 1 from app_private.get_overlay_events('00000000-0000-4000-8000-000000000091', null, null, 50)
        where event_id = '00000000-0000-4000-8000-000000000051'
     )
     or not exists (
       select 1 from app_private.get_overlay_events('00000000-0000-4000-8000-000000000091', null, null, 50)
        where event_id = '00000000-0000-4000-8000-000000000151'
          and payload ->> 'queueId' = '00000000-0000-4000-8000-000000000021'
          and payload -> 'overrideValues' ->> 'style' = 'payment'
          and trace_id = 'razorpay:provider-event-1'
     )
     or not exists (
       select 1 from app_private.get_overlay_events('00000000-0000-4000-8000-000000000091', null, null, 50)
        where event_id = '00000000-0000-4000-8000-000000000151'
          and payload ->> 'queueId' = '00000000-0000-4000-8000-000000000022'
          and payload -> 'overrideValues' ->> 'style' = 'payment-secondary'
          and trace_id = 'razorpay:provider-event-1'
     )
     or not exists (
       select 1 from app_private.get_overlay_events('00000000-0000-4000-8000-000000000091', null, null, 50)
        where event_id = '00000000-0000-4000-8000-000000000151'
          and payload -> 'configSnapshot' ->> 'defaultStyle' = 'celebration'
          and (payload -> 'configSnapshot' -> 'display' ->> 'anchor') = 'top_right'
     ) then
    raise exception 'L03 overlay projection lost independent delivery routing snapshot';
  end if;
end
$$;
select app_private.ack_overlay_cursor(
  '00000000-0000-4000-8000-000000000091',
  '2026-08-14T10:45:48.527358Z|00000000-0000-4000-8000-000000000081',
  '00000000-0000-4000-8000-000000000051'
);
do $$
declare invalid_ack boolean;
begin
  select app_private.ack_overlay_cursor(
    '00000000-0000-4000-8000-000000000091',
    '2026-08-14T10:45:48.527358Z|00000000-0000-4000-8000-000000000081',
    '00000000-0000-4000-8000-000000000052'
  ) into invalid_ack;
  if invalid_ack then
    raise exception 'L03 invalid overlay cursor acknowledgement unexpectedly accepted';
  end if;
end
$$;
do $$
declare
  replay_cursor text;
begin
  select overlay_event.cursor
    into replay_cursor
    from app_private.get_overlay_events(
      '00000000-0000-4000-8000-000000000091', null, null, 100
    ) overlay_event
   where overlay_event.payload ->> 'deliveryId' = '00000000-0000-4000-8000-000000000182';
  if replay_cursor is null then
    raise exception 'L05 resumed overlay event did not expose an acknowledgement cursor';
  end if;
  if not app_private.ack_overlay_cursor(
    '00000000-0000-4000-8000-000000000091',
    replay_cursor,
    '00000000-0000-4000-8000-000000000151'
  ) then
    raise exception 'L05 resumed overlay acknowledgement failed';
  end if;
end
$$;
do $$
begin
  set local role postgres;
  if (select status from event_outbox_deliveries where id = '00000000-0000-4000-8000-000000000182') <> 'acknowledged'
     or (select status from event_outbox where id = '00000000-0000-4000-8000-000000000161') <> 'completed' then
    raise exception 'L05 outbox projection refresh failed after overlay acknowledgement';
  end if;
end
$$;
set local role bsa_app;
select * from app_private.get_companion_state('00000000-0000-4000-8000-000000000011');
commit;

-- Replay safety under out-of-order publication: the newer delivery is
-- acknowledged first, but the older durable delivery must remain visible when
-- the overlay reconnects with the newer cursor. A cursor is an acknowledgement
-- checkpoint, not permission to hide unacknowledged rows.
insert into alert_events (
  id, channel_id, payment_id, source_type, source_id, trace_id,
  config_snapshot_version, payload, created_at
) values
  (
    '00000000-0000-4000-8000-000000000231',
    '00000000-0000-4000-8000-000000000011', null, 'manual',
    'replay-order-old', 'trace-replay-order-old', 1,
    '{"displayName":"Older alert","message":"must replay"}'::jsonb,
    '2026-08-15T10:00:00Z'::timestamptz
  ),
  (
    '00000000-0000-4000-8000-000000000234',
    '00000000-0000-4000-8000-000000000011', null, 'manual',
    'replay-order-new', 'trace-replay-order-new', 1,
    '{"displayName":"Newer alert","message":"acknowledged first"}'::jsonb,
    '2026-08-15T10:00:01Z'::timestamptz
  );
insert into event_outbox (id, event_id, status, available_at, created_at, updated_at)
values
  (
    '00000000-0000-4000-8000-000000000232',
    '00000000-0000-4000-8000-000000000231', 'completed',
    '2026-08-15T10:00:00Z'::timestamptz,
    '2026-08-15T10:00:00Z'::timestamptz,
    '2026-08-15T10:00:00Z'::timestamptz
  ),
  (
    '00000000-0000-4000-8000-000000000235',
    '00000000-0000-4000-8000-000000000234', 'completed',
    '2026-08-15T10:00:01Z'::timestamptz,
    '2026-08-15T10:00:01Z'::timestamptz,
    '2026-08-15T10:00:01Z'::timestamptz
  );
insert into event_outbox_deliveries (
  id, event_id, outbox_id, queue_id, binding_id, source_id,
  config_snapshot_version, delivery_sequence, source_priority, override_values,
  status, attempt_count, created_at, updated_at
)
values
  (
    '00000000-0000-4000-8000-000000000233',
    '00000000-0000-4000-8000-000000000231',
    '00000000-0000-4000-8000-000000000232',
    '00000000-0000-4000-8000-000000000021',
    '00000000-0000-4000-8000-000000000032',
    'replay-order-old', 1, 1, 0, '{}', 'ready', 0,
    '2026-08-15T10:00:00Z'::timestamptz,
    '2026-08-15T10:00:00Z'::timestamptz
  ),
  (
    '00000000-0000-4000-8000-000000000236',
    '00000000-0000-4000-8000-000000000234',
    '00000000-0000-4000-8000-000000000235',
    '00000000-0000-4000-8000-000000000021',
    '00000000-0000-4000-8000-000000000032',
    'replay-order-new', 1, 2, 0, '{}', 'acknowledged', 0,
    '2026-08-15T10:00:01Z'::timestamptz,
    '2026-08-15T10:00:01Z'::timestamptz
  );

begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', true);
select set_config('app.overlay_session_id', '00000000-0000-4000-8000-000000000091', true);
do $$
declare
  replayed_old boolean;
begin
  select exists (
    select 1
      from app_private.get_overlay_events(
        '00000000-0000-4000-8000-000000000091',
        '2026-08-15T10:00:01Z'::timestamptz,
        '00000000-0000-4000-8000-000000000236',
        100
      ) event_row
     where event_row.event_id = '00000000-0000-4000-8000-000000000231'
       and event_row.payload ->> 'deliveryId' = '00000000-0000-4000-8000-000000000233'
  ) into replayed_old;
  if not replayed_old then
    raise exception 'out-of-order publication hid an older unacknowledged delivery';
  end if;
end
$$;
commit;

-- Queue lifecycle safety: closing one queue is allowed, but the final open
-- queue cannot be closed, and no new delivery may target the closed queue.
begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', true);
update alert_queues
   set closed_at = current_timestamp, updated_at = current_timestamp
 where id = '00000000-0000-4000-8000-000000000022';
do $$
begin
  begin
    update alert_queues
       set closed_at = current_timestamp, updated_at = current_timestamp
     where id = '00000000-0000-4000-8000-000000000021';
    raise exception 'final open alert queue unexpectedly closed';
  exception when check_violation then
    null;
  end;
end
$$;
commit;

-- A closed queue remains in history, but cannot receive a new routing binding.
begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', true);
do $$
begin
  begin
    insert into queue_bindings (
      id, channel_id, queue_id, source_type, source_id,
      allow_duplicates, priority, created_at
    ) values (
      '00000000-0000-4000-8000-000000000238',
      '00000000-0000-4000-8000-000000000011',
      '00000000-0000-4000-8000-000000000022',
      'manual', 'closed-binding-guard', false, 0, current_timestamp
    );
    raise exception 'closed queue binding unexpectedly accepted';
  exception when insufficient_privilege then
    null;
  end;
end
$$;
commit;

insert into alert_events (
  id, channel_id, payment_id, source_type, source_id, trace_id,
  config_snapshot_version, payload, created_at
) values (
  '00000000-0000-4000-8000-000000000201',
  '00000000-0000-4000-8000-000000000011', null, 'manual',
  'closed-queue-guard', 'trace-closed-queue-guard', 1, '{}', current_timestamp
);
insert into event_outbox (id, event_id, status, available_at, created_at, updated_at)
values (
  '00000000-0000-4000-8000-000000000202',
  '00000000-0000-4000-8000-000000000201', 'pending', current_timestamp,
  current_timestamp, current_timestamp
);
begin;
do $$
begin
  begin
    insert into event_outbox_deliveries (
      id, event_id, outbox_id, queue_id, binding_id, source_id,
      config_snapshot_version, delivery_sequence, source_priority, override_values,
      status, attempt_count, created_at, updated_at
    ) values (
      '00000000-0000-4000-8000-000000000203',
      '00000000-0000-4000-8000-000000000201',
      '00000000-0000-4000-8000-000000000202',
      '00000000-0000-4000-8000-000000000022',
      '00000000-0000-4000-8000-000000000034',
      'closed-queue-guard', 1, 1, 1, '{}', 'ready', 0,
      current_timestamp, current_timestamp
    );
    raise exception 'closed queue delivery unexpectedly accepted';
  exception when check_violation then
    null;
  end;
end
$$;
commit;

do $$
begin
  if (select count(*) from companion_commands where channel_id = '00000000-0000-4000-8000-000000000011' and idempotency_key = 'command-a-001') <> 1 then
    raise exception 'L03 Companion idempotency failed';
  end if;
  if (select count(*) from alert_events where id = '00000000-0000-4000-8000-000000000221') <> 1
     or (select count(*) from event_outbox_deliveries where event_id = '00000000-0000-4000-8000-000000000221') <> 1
     or (select count(*) from companion_commands where idempotency_key = 'command-test-001') <> 1
     or (select result_event_id from companion_commands where idempotency_key = 'command-test-001') <> '00000000-0000-4000-8000-000000000221' then
    raise exception 'Companion test alert was not durable and idempotent';
  end if;
  if (select count(*) from overlay_cursors where overlay_session_id = '00000000-0000-4000-8000-000000000091') < 2 then
    raise exception 'L03 overlay cursor acknowledgement failed';
  end if;
end
$$;

-- Companion action layouts are append-only, tier-limited and independent of
-- delivery evidence. The synthetic channel is Creator (32 slots); the first
-- saved layout starts at version 1 and can be replaced only with version 2.
begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', true);
insert into alert_queues (id, channel_id, name, created_at, updated_at)
values ('00000000-0000-4000-8000-000000000023', '00000000-0000-4000-8000-000000000011', 'Synthetic Companion layout', current_timestamp, current_timestamp);
select * from app_private.get_companion_layout('00000000-0000-4000-8000-000000000011');
select * from app_private.update_companion_layout(
  '00000000-0000-4000-8000-000000000011',
  '00000000-0000-4000-8000-000000000001',
  0,
  4,
  '[
    {"slotIndex":1,"page":1,"label":"Pause","action":"pause_queue","targetId":"00000000-0000-4000-8000-000000000023"},
    {"slotIndex":2,"page":1,"label":"Test","action":"send_test_alert","targetId":"00000000-0000-4000-8000-000000000023"}
  ]'::jsonb
);
commit;

do $$
declare
  layout_count integer;
  saved_version bigint;
  saved_limit integer;
begin
  select count(*), max(version) into layout_count, saved_version
    from companion_layout_versions
   where channel_id = '00000000-0000-4000-8000-000000000011';
  select max_slots into saved_limit
    from app_private.get_companion_layout('00000000-0000-4000-8000-000000000011'::uuid);
  if layout_count <> 1 or saved_version <> 1 or saved_limit <> 32 then
    raise exception 'Companion Creator layout was not persisted with the approved 32-slot limit';
  end if;
end
$$;

-- An operator may save a later layout, but a moderator cannot use the layout
-- writer. The test also proves page size remains in the approved set.
begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000000004', true);
select * from app_private.update_companion_layout(
  '00000000-0000-4000-8000-000000000011',
  '00000000-0000-4000-8000-000000000004',
  1,
  8,
  '[]'::jsonb
);
commit;

do $$
begin
  set local role bsa_app;
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000005', true);
  begin
    perform * from app_private.update_companion_layout(
      '00000000-0000-4000-8000-000000000011',
      '00000000-0000-4000-8000-000000000005',
      2,
      4,
      '[]'::jsonb
    );
    raise exception 'moderator unexpectedly updated Companion layout';
  exception when insufficient_privilege then
    null;
  end;
end
$$;

-- The Creator allocation is finite and the failure is isolated to new layout
-- configuration. Accepted event/outbox rows remain present after rejection.
do $$
declare
  too_many_slots jsonb;
begin
  select jsonb_agg(jsonb_build_object(
    'slotIndex', n,
    'page', 1,
    'label', 'Action ' || n,
    'action', 'pause_queue',
    'targetId', '00000000-0000-4000-8000-000000000023'
  ) order by n)
    into too_many_slots
    from generate_series(1, 33) n;
  set local role bsa_app;
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000001', true);
  begin
    perform * from app_private.update_companion_layout(
      '00000000-0000-4000-8000-000000000011',
      '00000000-0000-4000-8000-000000000001',
      2,
      4,
      too_many_slots
    );
    raise exception 'Creator layout above 32 slots unexpectedly accepted';
  exception when sqlstate '22023' then
    null;
  end;
end
$$;

do $$
begin
  if (select count(*) from companion_layout_versions where channel_id = '00000000-0000-4000-8000-000000000011') <> 2
     or (select count(*) from alert_events where id = '00000000-0000-4000-8000-000000000221') <> 1
     or (select count(*) from event_outbox_deliveries where event_id = '00000000-0000-4000-8000-000000000221') <> 1 then
    raise exception 'Companion layout limits affected durable alert evidence';
  end if;
end
$$;

update alert_queues
   set closed_at = current_timestamp, updated_at = current_timestamp
 where id = '00000000-0000-4000-8000-000000000023';

-- Credential lifecycle and Companion controls are role-scoped at the table
-- boundary, not only hidden by the web/mobile UI. Operators may manage the
-- browser-source credential and issue finite Companion controls. Viewers and
-- moderators may not obtain the credential or issue queue controls.
begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000000004', true);
insert into overlay_sessions (id, channel_id, token_fingerprint, expires_at, created_at)
values ('00000000-0000-4000-8000-000000000094', '00000000-0000-4000-8000-000000000011', 'fingerprint-operator', current_timestamp + interval '1 hour', current_timestamp);
insert into companion_commands (id, channel_id, actor_user_id, idempotency_key, action, target_id, status, created_at)
values ('00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000004', 'command-operator-001', 'pause_queue', '00000000-0000-4000-8000-000000000021', 'accepted', current_timestamp);
commit;

do $$
begin
  set local role bsa_app;
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000006', true);
  begin
    insert into overlay_sessions (id, channel_id, token_fingerprint, expires_at, created_at)
    values ('00000000-0000-4000-8000-000000000095', '00000000-0000-4000-8000-000000000011', 'fingerprint-viewer', current_timestamp + interval '1 hour', current_timestamp);
    raise exception 'viewer unexpectedly managed an overlay session';
  exception when insufficient_privilege then
    null;
  end;

  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000005', true);
  begin
    insert into companion_commands (id, channel_id, actor_user_id, idempotency_key, action, target_id, status, created_at)
    values ('00000000-0000-4000-8000-000000000302', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000005', 'command-moderator-001', 'pause_queue', '00000000-0000-4000-8000-000000000021', 'accepted', current_timestamp);
    raise exception 'moderator unexpectedly issued a Companion queue command';
  exception when insufficient_privilege then
    null;
  end;
end
$$;

do $$
begin
  if (select count(*) from overlay_sessions where id = '00000000-0000-4000-8000-000000000094') <> 1
     or (select count(*) from overlay_sessions where id = '00000000-0000-4000-8000-000000000095') <> 0
     or (select count(*) from companion_commands where id = '00000000-0000-4000-8000-000000000301') <> 1
     or (select count(*) from companion_commands where id = '00000000-0000-4000-8000-000000000302') <> 0 then
    raise exception 'L03/L07 role guards did not enforce the approved matrix';
  end if;
end
$$;

-- The API allowlist is backed by a database check as well. Historical rows
-- are preserved, but a privileged caller cannot create a removed legacy
-- Companion action through a direct table path.
begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', true);
do $$
begin
  begin
    insert into companion_commands (id, channel_id, actor_user_id, idempotency_key, action, target_id, status, created_at)
    values ('00000000-0000-4000-8000-000000000303', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001', 'command-legacy-action-001', 'approve_alert', '00000000-0000-4000-8000-000000000021', 'accepted', current_timestamp);
    raise exception 'legacy Companion action unexpectedly accepted';
  exception when check_violation then
    null;
  end;
end
$$;
commit;

begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', true);
do $$
begin
  begin
    insert into queue_bindings (id, channel_id, queue_id, source_type, source_id, allow_duplicates, priority, override_values, created_at)
    values ('00000000-0000-4000-8000-000000000092', '00000000-0000-4000-8000-000000000013', '00000000-0000-4000-8000-000000000021', 'payment', 'cross-channel-binding', false, 1, '{}', current_timestamp);
    raise exception 'cross-channel queue binding unexpectedly accepted';
  exception when insufficient_privilege then
    null;
  end;
end
$$;
commit;

begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', true);
do $$
begin
  begin
    insert into alert_moderation_actions (id, event_id, channel_id, actor_user_id, action, reason, created_at)
    values ('00000000-0000-4000-8000-000000000092', '00000000-0000-4000-8000-000000000051', '00000000-0000-4000-8000-000000000013', '00000000-0000-4000-8000-000000000001', 'hold', 'cross-channel test', current_timestamp);
    raise exception 'cross-channel moderation unexpectedly accepted';
  exception when insufficient_privilege then
    null;
  end;
end
$$;
commit;

begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000000002', true);
select count(*) as cross_tenant_channels from channels where id = '00000000-0000-4000-8000-000000000011';
select count(*) as cross_tenant_events from alert_events where channel_id = '00000000-0000-4000-8000-000000000011';
select count(*) as cross_tenant_overlays from overlay_sessions where channel_id = '00000000-0000-4000-8000-000000000011';
do $$
begin
  begin
    perform * from app_private.create_manual_alert(
      '00000000-0000-4000-8000-000000000052',
      '00000000-0000-4000-8000-000000000062',
      '00000000-0000-4000-8000-000000000011',
      '00000000-0000-4000-8000-000000000002',
      'trace-l03-cross-tenant', 1, '{}'
    );
    raise exception 'cross-tenant manual alert unexpectedly accepted';
  exception when insufficient_privilege then
    null;
  end;
end
$$;
commit;

do $$
begin
  if (select count(*) from alert_moderation_actions where event_id = '00000000-0000-4000-8000-000000000051') <> 1 then
    raise exception 'L03 moderation action missing';
  end if;
end
$$;

-- L07 control sessions are short-lived, server-owned operational leases. A
-- Free channel admits one active lease, the same client instance may renew
-- idempotently, and revocation is retained as audit state. None of this path
-- touches payment, queue, outbox or delivery state.
insert into channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at)
values ('00000000-0000-4000-8000-000000000012', 999, 'free', 'individual_plan', '{}', current_timestamp, current_timestamp);
begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000000002', true);
select * from app_private.acquire_companion_control_session(
  '00000000-0000-4000-8000-000000000401',
  '00000000-0000-4000-8000-000000000012',
  '00000000-0000-4000-8000-000000000002',
  'mobile', 'mobile-instance-0001', current_timestamp + interval '5 minutes'
);
select * from app_private.acquire_companion_control_session(
  '00000000-0000-4000-8000-000000000402',
  '00000000-0000-4000-8000-000000000012',
  '00000000-0000-4000-8000-000000000002',
  'mobile', 'mobile-instance-0001', current_timestamp + interval '10 minutes'
);
do $$
begin
  begin
    perform * from app_private.acquire_companion_control_session(
      '00000000-0000-4000-8000-000000000403',
      '00000000-0000-4000-8000-000000000012',
      '00000000-0000-4000-8000-000000000002',
      'desktop', 'desktop-instance-0001', current_timestamp + interval '5 minutes'
    );
    raise exception 'free channel admitted a second active control session';
  exception when others then
    if sqlerrm <> 'free Companion control session already active' then
      raise;
    end if;
  end;
end
$$;
do $$
begin
  begin
    perform app_private.revoke_companion_control_session(
      '00000000-0000-4000-8000-000000000401',
      '00000000-0000-0000-0000-000000000013',
      '00000000-0000-4000-8000-000000000002', 'wrong-channel'
    );
    raise exception 'control session was revoked through the wrong channel scope';
  exception when others then
    if sqlerrm <> 'Companion control access denied' then
      raise;
    end if;
  end;
end
$$;
select app_private.revoke_companion_control_session(
  '00000000-0000-4000-8000-000000000401',
  '00000000-0000-4000-8000-000000000012',
  '00000000-0000-4000-8000-000000000002', 'test revoke'
);
commit;

begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000000002', true);
select * from app_private.acquire_companion_control_session(
  '00000000-0000-4000-8000-000000000404',
  '00000000-0000-4000-8000-000000000012',
  '00000000-0000-4000-8000-000000000002',
  'mobile', 'mobile-instance-0001', current_timestamp + interval '5 minutes'
);
commit;

do $$
begin
  if (select count(*) from companion_control_sessions where id = '00000000-0000-4000-8000-000000000401' and revoked_at is not null) <> 1
     or (select count(*) from companion_control_sessions where id = '00000000-0000-4000-8000-000000000402') <> 0
     or (select count(*) from companion_control_sessions where id = '00000000-0000-4000-8000-000000000403') <> 0
     or (select count(*) from companion_control_sessions where id = '00000000-0000-4000-8000-000000000404' and revoked_at is null) <> 1 then
    raise exception 'Companion control session lease/revoke state failed';
  end if;
  if has_table_privilege('bsa_app', 'public.companion_control_sessions', 'INSERT')
     or has_table_privilege('bsa_app', 'public.companion_control_sessions', 'UPDATE')
     or has_table_privilege('bsa_app', 'public.companion_control_sessions', 'DELETE') then
    raise exception 'Companion control sessions are directly writable by the request role';
  end if;
end
$$;

select 'L03_APPLICATION_BEHAVIOR=PASS' as result;
