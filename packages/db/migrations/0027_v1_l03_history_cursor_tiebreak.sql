-- L03 deterministic history pagination.
-- Timestamp-only pagination can skip or repeat rows when several events share
-- the same created_at value. The new overload adds event.id as a stable
-- descending tie-breaker while the old function remains for compatibility with
-- already deployed callers during migration.

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
         payment.gross_amount_paise,
         payment.currency,
         nullif(event.payload ->> 'displayName', ''),
         nullif(event.payload ->> 'message', '')
    from public.alert_events event
    left join public.event_outbox outbox on outbox.event_id = event.id
    left join public.payments payment on payment.id = event.payment_id
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

revoke execute on function app_private.get_alert_history(uuid, timestamptz, uuid, integer) from public;
grant execute on function app_private.get_alert_history(uuid, timestamptz, uuid, integer) to bsa_app;
