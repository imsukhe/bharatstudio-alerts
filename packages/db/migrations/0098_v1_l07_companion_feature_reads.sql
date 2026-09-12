-- L07 Companion remaining feature list (master plan 7.11 items 2, 5, 8-10).
--
-- Scope of this migration (see this task's owning header comment in
-- apps/api/src/routes/companion.ts and apps/api/src/db/companion-feature-*.ts):
--   - Mute upcoming TTS / cancel currently-playing TTS (item 5). Two
--     distinct operations on two distinct targets: mute is a per-queue,
--     forward-looking toggle; cancel is a one-shot transition of one
--     specific in-flight delivery. Implemented as new, named, validated
--     functions -- NOT added to migration 0089's 17-action Companion
--     catalogue, because that catalogue is mirrored by hand across five
--     files including two files in the sibling companion-desktop repo,
--     which this task's file-ownership boundary does not include (see the
--     "Action vs read decision" table in this task's return report). These
--     remain genuine control operations (not reads), so they are
--     implemented as their own bounded, enumerated, role- and
--     entitlement-gated routes -- the same shape migration 0093 already
--     used for the OBS-status heartbeat report, which also lives outside
--     the 17-action catalogue for an analogous reason (a different
--     authentication model, there; a different mirror set, here).
--   - Run full test (item 2): a report over the real alert pipeline for one
--     event, reusing the *existing* 'send_test_alert' catalogue action to
--     actually create the event (no new catalogue entry needed) and adding
--     a hop-by-hop snapshot query on top.
--   - Payment/refund status and recent tips (items 9-10 and 8): read-only
--     projections. Not Companion actions -- actions are for control, these
--     are views over already-existing tables (payments/refunds,
--     alert_events), so they are plain SQL functions, not
--     companion_commands rows. Recent tips reuses 0039's per-role donor-
--     visibility CASE pattern verbatim (owner/admin see amounts; operator/
--     moderator additionally see donor name/message; viewer sees neither).
--
-- Every function below follows 0089/0093's own precedent: security
-- definer, explicit search_path, revoke from public + grant to bsa_app,
-- and NOT VALID on any widened CHECK constraint (append-only evidence,
-- no full-table rewrite).

-- 1. Mute state lives on the queue (forward-looking: "TTS for this queue's
--    future deliveries is muted starting now"), not on any single event or
--    delivery -- matching how quiet_mode_active (0062) already models a
--    forward-looking suppression toggle. Nullable timestamp, not a plain
--    boolean, so "when was this last muted" survives without a second
--    column, exactly like companion_control_sessions.obs_status_reported_at
--    (0093) uses a timestamp rather than a boolean for the same reason.
alter table public.alert_queues
  add column tts_muted_at timestamptz;

comment on column public.alert_queues.tts_muted_at is
  'L07 Companion "mute upcoming TTS": set when a channel operator mutes this queue''s future TTS deliveries, cleared (null) on unmute. Forward-looking only -- does not affect a delivery already in flight; see cancel_companion_tts_delivery for that.';

-- 2. Cancel is a one-shot transition of one specific in-flight delivery, so
--    it needs its own terminal status distinguishable from every other
--    terminal status already on event_outbox_deliveries (0001) --
--    'suppressed' means something else (never displayed, upstream
--    suppression rule) and would make an operator's "I cancelled this the
--    TTS while it was playing" indistinguishable from an automatic
--    upstream suppression in history/audit views.
alter table public.event_outbox_deliveries
  drop constraint if exists event_outbox_deliveries_status_check;

alter table public.event_outbox_deliveries
  add constraint event_outbox_deliveries_v1_status_check
  check (status in (
    'pending', 'ready', 'held', 'displayed', 'acknowledged',
    'failed_retriable', 'quarantined', 'suppressed', 'refunded_after_display',
    -- 'discarded' was added by migration 0073 (admin DLQ tooling, unowned/
    -- unchanged here) -- carried forward so this widen does not regress it.
    'discarded',
    'tts_cancelled'
  )) not valid;

comment on constraint event_outbox_deliveries_v1_status_check on public.event_outbox_deliveries is
  'v1+L07 adds tts_cancelled (operator cancelled an in-flight TTS delivery via Companion); historical rows preserved, constraint intentionally not validated against them, following 0089''s own precedent.';

-- 3. Mute / unmute a queue's upcoming TTS. Entitlement layer: the channel's
--    latest entitlement values must have ttsEnabled = true (the existing
--    per-tier dimension from 0089/tier_entitlement_dimensions -- free is
--    false, pro/creator/studio are true); no entitlement row at all reads
--    as not-entitled, same honesty rule 0089 applied to the Alerts action
--    group. Activation (is Alerts actually running right now) is left to
--    the caller (apps/api/src/routes/companion.ts), which already has
--    overlayConnected via get_companion_state and applies it uniformly to
--    every 'alerts'-domain Companion capability, not just the 17-action
--    catalogue.
create or replace function app_private.set_companion_tts_mute(
  target_channel_id uuid,
  target_user_id uuid,
  target_queue_id uuid,
  target_muted boolean
)
returns table (
  queue_id uuid,
  tts_muted boolean,
  tts_muted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  tts_enabled boolean;
  updated_at_value timestamptz;
begin
  if target_user_id <> app_private.current_user_id() then
    raise exception 'actor mismatch' using errcode = '42501';
  end if;
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin', 'operator']::text[]) then
    raise exception 'channel access denied' using errcode = '42501';
  end if;

  select coalesce((entitlement.values ->> 'ttsEnabled')::boolean, false)
    into tts_enabled
    from public.channel_entitlement_versions entitlement
   where entitlement.channel_id = target_channel_id
   order by entitlement.version desc
   limit 1;
  if not coalesce(tts_enabled, false) then
    raise exception 'TTS is not entitled for this channel' using errcode = '22023';
  end if;

  update public.alert_queues queue
     set tts_muted_at = case when target_muted then current_timestamp else null end,
         updated_at = current_timestamp
   where queue.id = target_queue_id
     and queue.channel_id = target_channel_id
     and queue.closed_at is null
  returning queue.updated_at into updated_at_value;

  if updated_at_value is null then
    raise exception 'Companion TTS mute target queue is not active in channel' using errcode = '22023';
  end if;

  return query
    select queue.id, (queue.tts_muted_at is not null), queue.tts_muted_at
      from public.alert_queues queue
     where queue.id = target_queue_id;
end
$$;

revoke execute on function app_private.set_companion_tts_mute(uuid, uuid, uuid, boolean) from public;
grant execute on function app_private.set_companion_tts_mute(uuid, uuid, uuid, boolean) to bsa_app;

-- 4. Cancel one specific in-flight delivery. Only 'ready' (queued, about to
--    play) or 'displayed' (BharatStudio's existing name for "currently
--    shown/playing" -- see 0039's get_alert_history, which maps outbox
--    status 'completed' to the client-facing label 'displayed') deliveries
--    are cancellable; every other status is already terminal or not yet
--    live, and cancelling those would misrepresent what happened. Same
--    entitlement/role gate as mute, above.
create or replace function app_private.cancel_companion_tts_delivery(
  target_channel_id uuid,
  target_user_id uuid,
  target_delivery_id uuid
)
returns table (
  delivery_id uuid,
  event_id uuid,
  status text,
  cancelled_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  tts_enabled boolean;
  found_event_id uuid;
  found_status text;
  cancelled_at_value timestamptz;
begin
  if target_user_id <> app_private.current_user_id() then
    raise exception 'actor mismatch' using errcode = '42501';
  end if;
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin', 'operator']::text[]) then
    raise exception 'channel access denied' using errcode = '42501';
  end if;

  select coalesce((entitlement.values ->> 'ttsEnabled')::boolean, false)
    into tts_enabled
    from public.channel_entitlement_versions entitlement
   where entitlement.channel_id = target_channel_id
   order by entitlement.version desc
   limit 1;
  if not coalesce(tts_enabled, false) then
    raise exception 'TTS is not entitled for this channel' using errcode = '22023';
  end if;

  select delivery.event_id, delivery.status
    into found_event_id, found_status
    from public.event_outbox_deliveries delivery
    join public.alert_events event on event.id = delivery.event_id
   where delivery.id = target_delivery_id
     and event.channel_id = target_channel_id;

  if found_event_id is null then
    raise exception 'Companion TTS cancel target delivery was not found in channel' using errcode = '22023';
  end if;
  if found_status not in ('ready', 'displayed') then
    raise exception 'Companion TTS cancel target delivery is not currently playing or queued' using errcode = '22023';
  end if;

  update public.event_outbox_deliveries delivery
     set status = 'tts_cancelled',
         updated_at = current_timestamp
   where delivery.id = target_delivery_id
  returning delivery.updated_at into cancelled_at_value;

  return query select target_delivery_id, found_event_id, 'tts_cancelled'::text, cancelled_at_value;
end
$$;

revoke execute on function app_private.cancel_companion_tts_delivery(uuid, uuid, uuid) from public;
grant execute on function app_private.cancel_companion_tts_delivery(uuid, uuid, uuid) to bsa_app;

-- 5. Run full test report: a hop-by-hop snapshot for one event, taken
--    *after* the caller has already created that event via the existing
--    'send_test_alert' Companion action (apps/api/src/db/alert-store.ts,
--    unowned/unchanged -- this migration adds no new way to create an
--    event). Read-only, role-gated the same way every other Companion
--    read is (can_access_channel), so it never leaks another channel's
--    event by id.
create or replace function app_private.get_companion_test_report(
  target_channel_id uuid,
  target_event_id uuid
)
returns table (
  hop text,
  status text,
  occurred_at timestamptz,
  detail text
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  with scoped_event as (
    select event.id, event.created_at
      from public.alert_events event
     where event.id = target_event_id
       and event.channel_id = target_channel_id
       and app_private.can_access_channel(target_channel_id)
  )
  select 'event_created'::text, 'ok'::text, scoped_event.created_at, 'Alert event accepted'::text
    from scoped_event
  union all
  select 'outbox_enqueued'::text, outbox.status, outbox.updated_at, null::text
    from public.event_outbox outbox
    join scoped_event on scoped_event.id = outbox.event_id
  union all
  select 'delivery:' || queue.name, delivery.status, delivery.updated_at, delivery.last_error_code
    from public.event_outbox_deliveries delivery
    join public.alert_queues queue on queue.id = delivery.queue_id
    join scoped_event on scoped_event.id = delivery.event_id
   order by 1
$$;

-- alert_tts_audio existence is reported as its own hop, unioned separately
-- because it has no natural sort key shared with the query above once
-- 'order by 1' is applied inside a set-returning CTE branch; kept as a
-- second statement-level union via a wrapping function instead of fighting
-- the ORDER BY scope.
create or replace function app_private.get_companion_test_report_tts_hop(
  target_channel_id uuid,
  target_event_id uuid
)
returns table (
  hop text,
  status text,
  occurred_at timestamptz,
  detail text
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select 'tts_audio'::text,
         case when audio.event_id is null then 'not_synthesized' else 'synthesized' end,
         audio.created_at,
         audio.mime_type
    from public.alert_events event
    left join public.alert_tts_audio audio on audio.event_id = event.id
   where event.id = target_event_id
     and event.channel_id = target_channel_id
     and app_private.can_access_channel(target_channel_id)
$$;

revoke execute on function app_private.get_companion_test_report(uuid, uuid) from public;
revoke execute on function app_private.get_companion_test_report_tts_hop(uuid, uuid) from public;
grant execute on function app_private.get_companion_test_report(uuid, uuid) to bsa_app;
grant execute on function app_private.get_companion_test_report_tts_hop(uuid, uuid) to bsa_app;

-- 6. Payment/refund status: read-only, finance-role-gated exactly like
--    0039's payments_finance_select / refunds_finance_select RLS policies
--    (owner/admin only) -- this function does not widen who can see
--    amounts, it just gives Companion a bounded, ordered projection of the
--    same rows the dashboard already exposes to those roles.
create or replace function app_private.get_companion_payment_status(
  target_channel_id uuid,
  target_limit integer
)
returns table (
  payment_id uuid,
  status text,
  gross_amount_paise bigint,
  currency text,
  refund_status text,
  refund_amount_paise bigint,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select payment.id, payment.status, payment.gross_amount_paise, payment.currency,
         refund.status, refund.amount_paise,
         payment.created_at, payment.updated_at
    from public.payments payment
    left join lateral (
      select refund.status, refund.amount_paise
        from public.refunds refund
       where refund.payment_id = payment.id
       order by refund.created_at desc
       limit 1
    ) refund on true
   where payment.channel_id = target_channel_id
     and app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[])
   order by payment.created_at desc
   limit greatest(1, least(coalesce(target_limit, 20), 50))
$$;

revoke execute on function app_private.get_companion_payment_status(uuid, integer) from public;
grant execute on function app_private.get_companion_payment_status(uuid, integer) to bsa_app;

-- 7. Recent tips: read-only, donor-visibility-scoped exactly like 0039's
--    get_alert_history (owner/admin see amounts; owner/admin/operator/
--    moderator additionally see donor display name and message; viewer
--    sees neither) -- reused verbatim rather than re-derived, per this
--    task's instruction to cover "a role without permission cannot
--    approve/reject" and "read views never leak another channel's data".
--    Restricted to source_type = 'payment' rows only (a "tip" is a paid
--    event; manual/companion test alerts are not tips).
create or replace function app_private.get_companion_recent_tips(
  target_channel_id uuid,
  target_limit integer
)
returns table (
  event_id uuid,
  display_name text,
  message text,
  gross_amount_paise bigint,
  currency text,
  created_at timestamptz
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
         case when membership.role in ('owner', 'admin', 'operator', 'moderator')
           then nullif(event.payload ->> 'displayName', '') else null end,
         case when membership.role in ('owner', 'admin', 'operator', 'moderator')
           then nullif(event.payload ->> 'message', '') else null end,
         case when membership.role in ('owner', 'admin') then payment.gross_amount_paise else null end,
         case when membership.role in ('owner', 'admin') then payment.currency else null end,
         event.created_at
    from public.alert_events event
    join public.payments payment on payment.id = event.payment_id
    cross join membership
   where event.channel_id = target_channel_id
     and event.source_type = 'payment'
     and app_private.can_access_channel(target_channel_id)
   order by event.created_at desc
   limit greatest(1, least(coalesce(target_limit, 20), 50))
$$;

revoke execute on function app_private.get_companion_recent_tips(uuid, integer) from public;
grant execute on function app_private.get_companion_recent_tips(uuid, integer) to bsa_app;
