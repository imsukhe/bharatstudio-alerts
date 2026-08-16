-- L03 acceptance: the creator-facing payment ledger read
-- (app_private.list_channel_payments) is owner/admin only, paginates
-- oldest-cursor-forward, and aggregates refunds per payment without
-- exposing anything a lower role shouldn't see. Synthetic identifiers only.
--
-- Runs inside one transaction that always rolls back: channel 011 already
-- carries payment fixtures from l03_application_behavior.sql, and this test
-- must neither assume it owns the absolute first ledger page nor leave rows
-- behind that change another test's payment count for that channel later
-- in the same shared disposable database.

\set ON_ERROR_STOP on

begin;

insert into payments (
  id, channel_id, provider, provider_payment_id, provider_order_id,
  gross_amount_paise, currency, status, environment, connected_account_ref,
  created_at, updated_at
)
values
  ('00000000-0000-4000-8000-000000000701', '00000000-0000-4000-8000-000000000011', 'razorpay', 'pay_ledger_older', 'order_ledger_older', 30000, 'INR', 'captured', 'test', 'acct_synthetic_a', current_timestamp - interval '2 days', current_timestamp - interval '2 days'),
  ('00000000-0000-4000-8000-000000000702', '00000000-0000-4000-8000-000000000011', 'razorpay', 'pay_ledger_newer', 'order_ledger_newer', 50000, 'INR', 'partially_refunded', 'test', 'acct_synthetic_a', current_timestamp - interval '1 day', current_timestamp - interval '1 day');

insert into refunds (id, payment_id, provider_refund_id, amount_paise, status, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000000703', '00000000-0000-4000-8000-000000000702', 'rfnd_ledger_1', 10000, 'processed', current_timestamp - interval '12 hours', current_timestamp - interval '12 hours'),
  ('00000000-0000-4000-8000-000000000704', '00000000-0000-4000-8000-000000000702', 'rfnd_ledger_2', 5000, 'requested', current_timestamp - interval '1 hour', current_timestamp - interval '1 hour');

do $$
declare
  newer record;
  older record;
  operator_count integer;
  viewer_count integer;
begin
  set role bsa_app;

  -- Owner: both synthetic payments are present, correctly ordered relative
  -- to each other (newer first), with refunds aggregated per payment —
  -- 15000 total / latest-by-created_at 'requested' for the refunded one,
  -- 0 / null (not missing) for the one with no refunds.
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000001', true);
  select * into newer
    from app_private.list_channel_payments('00000000-0000-4000-8000-000000000011', null, null, 100)
   where payment_id = '00000000-0000-4000-8000-000000000702';
  select * into older
    from app_private.list_channel_payments('00000000-0000-4000-8000-000000000011', null, null, 100)
   where payment_id = '00000000-0000-4000-8000-000000000701';
  if newer.refund_total_paise <> 15000 or newer.latest_refund_status <> 'requested' then
    raise exception 'owner ledger refund aggregation was wrong: %', newer;
  end if;
  if older.refund_total_paise <> 0 or older.latest_refund_status is not null then
    raise exception 'owner ledger no-refund row was wrong: %', older;
  end if;

  -- Cursor-forward from the newer row must yield the older row next (and
  -- only rows strictly before the cursor — never re-includes the cursor
  -- row itself).
  if not exists (
    select 1 from app_private.list_channel_payments('00000000-0000-4000-8000-000000000011', newer.created_at, newer.payment_id, 100)
     where payment_id = '00000000-0000-4000-8000-000000000701'
  ) then
    raise exception 'cursor-forward page did not include the older payment';
  end if;
  if exists (
    select 1 from app_private.list_channel_payments('00000000-0000-4000-8000-000000000011', newer.created_at, newer.payment_id, 100)
     where payment_id = '00000000-0000-4000-8000-000000000702'
  ) then
    raise exception 'cursor-forward page re-included the cursor row itself';
  end if;

  -- Admin: same access as owner.
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000003', true);
  if not exists (
    select 1 from app_private.list_channel_payments('00000000-0000-4000-8000-000000000011', null, null, 100)
     where payment_id = '00000000-0000-4000-8000-000000000702'
  ) then
    raise exception 'admin could not read the payment ledger';
  end if;

  -- Operator/viewer: the launch authority grants owner/admin only —
  -- everyone else gets zero rows, matching get_billing_view's existing
  -- can_access_channel pattern (silent empty result, not an error).
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000004', true);
  select count(*) into operator_count
    from app_private.list_channel_payments('00000000-0000-4000-8000-000000000011', null, null, 100);
  if operator_count <> 0 then
    raise exception 'operator could read the owner/admin-only payment ledger';
  end if;

  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000006', true);
  select count(*) into viewer_count
    from app_private.list_channel_payments('00000000-0000-4000-8000-000000000011', null, null, 100);
  if viewer_count <> 0 then
    raise exception 'viewer could read the owner/admin-only payment ledger';
  end if;
exception when others then
  reset role;
  raise;
end
$$;
reset role;
rollback;

select 'L03_PAYMENT_LEDGER_READ=PASS' as result;
