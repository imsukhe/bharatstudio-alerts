-- L03: creator-facing payment ledger read.
--
-- 00_LAUNCH_SCOPE_AUTHORITY.md already grants this: "owner/admin may view
-- financial amounts and raw payment/refund records", and bsa_app has held
-- table select on public.payments/public.refunds since 0003, correctly
-- scoped by 0039's payments_finance_select/refunds_finance_select RLS
-- policies (owner/admin only) — but no application code had ever actually
-- read them: get_alert_history (0039) projects per-event financial fields,
-- not a payment-centric ledger, and nothing exposed cursor-paginated
-- payment+refund rows. This migration adds that dedicated read function,
-- explicitly re-checking the role in its WHERE clause — matching this
-- codebase's existing belt-and-suspenders pattern for other financial/
-- business-logic reads (get_billing_view, get_alert_history) — rather than
-- expecting callers to query the table raw.
--
-- Deliberately out of scope: a tax/CA-compliance report. That is a legal/
-- compliance conclusion this repository's own governance rule prohibits
-- deriving from unsupported assumptions — a plain data list is not a tax
-- computation, and this migration ships only the former.

create or replace function app_private.list_channel_payments(
  target_channel_id uuid,
  target_cursor_created_at timestamptz,
  target_cursor_id uuid,
  target_limit integer
)
returns table (
  payment_id uuid,
  provider_payment_id text,
  gross_amount_paise bigint,
  currency text,
  status text,
  created_at timestamptz,
  refund_total_paise bigint,
  latest_refund_status text
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select payment.id,
         payment.provider_payment_id,
         payment.gross_amount_paise,
         payment.currency,
         payment.status,
         payment.created_at,
         coalesce(refund_summary.refund_total_paise, 0),
         refund_summary.latest_refund_status
    from public.payments payment
    left join lateral (
      select sum(refund.amount_paise)::bigint as refund_total_paise,
             (array_agg(refund.status order by refund.created_at desc))[1] as latest_refund_status
        from public.refunds refund
       where refund.payment_id = payment.id
    ) refund_summary on true
   where payment.channel_id = target_channel_id
     and app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[])
     and (
       target_cursor_created_at is null
       or payment.created_at < target_cursor_created_at
       or (payment.created_at = target_cursor_created_at and payment.id < target_cursor_id)
     )
   order by payment.created_at desc, payment.id desc
   limit greatest(least(coalesce(target_limit, 25), 100), 1)
$$;

revoke execute on function app_private.list_channel_payments(uuid, timestamptz, uuid, integer) from public;
grant execute on function app_private.list_channel_payments(uuid, timestamptz, uuid, integer) to bsa_app;
