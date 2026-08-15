-- L03 role-scoped financial and alert-history projections.
--
-- Channel membership is not a financial permission.  Owner/admin may see
-- financial amounts and payment/refund rows.  Operator/moderator may see
-- alert content needed for operations/moderation, but not money.  Viewer may
-- see delivery status metadata only.  This is a read projection change; it
-- never deletes or changes accepted payment/alert evidence.

drop policy if exists payments_member_select on public.payments;
drop policy if exists refunds_member_select on public.refunds;

create policy payments_finance_select
  on public.payments for select to bsa_app
  using (app_private.has_channel_role(channel_id, array['owner', 'admin']::text[]));

create policy refunds_finance_select
  on public.refunds for select to bsa_app
  using (
    exists (
      select 1
        from public.payments payment
       where payment.id = refunds.payment_id
         and app_private.has_channel_role(payment.channel_id, array['owner', 'admin']::text[])
    )
  );

create or replace function app_private.get_alert_history(
  target_channel_id uuid,
  target_cursor timestamptz,
  target_limit integer
)
returns table (
  event_id uuid,
  source_type text,
  status text,
  created_at timestamptz,
  gross_amount_paise bigint,
  currency text,
  display_name text,
  message text
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  with membership as (
    select role
      from public.channel_memberships
     where channel_id = target_channel_id
       and user_id = app_private.current_user_id()
       and revoked_at is null
     limit 1
  )
  select event.id,
         event.source_type,
         case
           when outbox.status = 'completed' then 'displayed'
           when outbox.status = 'quarantined' then 'quarantined'
           when outbox.status = 'retryable_failure' then 'failed'
           when outbox.status = 'pending' then 'accepted'
           else coalesce(outbox.status, 'accepted')
         end,
         event.created_at,
         case when membership.role in ('owner', 'admin') then payment.gross_amount_paise else null end,
         case when membership.role in ('owner', 'admin') then payment.currency else null end,
         case when membership.role in ('owner', 'admin', 'operator', 'moderator')
           then nullif(event.payload ->> 'displayName', '') else null end,
         case when membership.role in ('owner', 'admin', 'operator', 'moderator')
           then nullif(event.payload ->> 'message', '') else null end
    from public.alert_events event
    left join public.event_outbox outbox on outbox.event_id = event.id
    left join public.payments payment on payment.id = event.payment_id
    cross join membership
   where event.channel_id = target_channel_id
     and app_private.can_access_channel(target_channel_id)
     and (target_cursor is null or event.created_at < target_cursor)
   order by event.created_at desc
   limit greatest(1, least(target_limit, 100))
$$;

create or replace function app_private.get_alert_history(
  target_channel_id uuid,
  target_cursor timestamptz,
  target_event_id uuid,
  target_limit integer
)
returns table (
  event_id uuid,
  source_type text,
  status text,
  created_at timestamptz,
  gross_amount_paise bigint,
  currency text,
  display_name text,
  message text
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  with membership as (
    select role
      from public.channel_memberships
     where channel_id = target_channel_id
       and user_id = app_private.current_user_id()
       and revoked_at is null
     limit 1
  )
  select event.id,
         event.source_type,
         case
           when outbox.status = 'completed' then 'displayed'
           when outbox.status = 'quarantined' then 'quarantined'
           when outbox.status = 'retryable_failure' then 'failed'
           when outbox.status = 'pending' then 'accepted'
           else coalesce(outbox.status, 'accepted')
         end,
         event.created_at,
         case when membership.role in ('owner', 'admin') then payment.gross_amount_paise else null end,
         case when membership.role in ('owner', 'admin') then payment.currency else null end,
         case when membership.role in ('owner', 'admin', 'operator', 'moderator')
           then nullif(event.payload ->> 'displayName', '') else null end,
         case when membership.role in ('owner', 'admin', 'operator', 'moderator')
           then nullif(event.payload ->> 'message', '') else null end
    from public.alert_events event
    left join public.event_outbox outbox on outbox.event_id = event.id
    left join public.payments payment on payment.id = event.payment_id
    cross join membership
   where event.channel_id = target_channel_id
     and app_private.can_access_channel(target_channel_id)
     and (
       target_cursor is null
       or event.created_at < target_cursor
       or (target_event_id is not null and event.created_at = target_cursor and event.id < target_event_id)
     )
   order by event.created_at desc, event.id desc
   limit greatest(1, least(target_limit, 100))
$$;

revoke execute on function app_private.get_alert_history(uuid, timestamptz, integer) from public;
revoke execute on function app_private.get_alert_history(uuid, timestamptz, uuid, integer) from public;
grant execute on function app_private.get_alert_history(uuid, timestamptz, integer) to bsa_app;
grant execute on function app_private.get_alert_history(uuid, timestamptz, uuid, integer) to bsa_app;
