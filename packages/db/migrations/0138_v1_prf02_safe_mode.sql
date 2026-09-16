-- PRF-02, §6 module #12: SAFE MODE -- the half slice 5 deliberately did
-- not build.
--
-- AUTHORITY. bharatstudio-requirements/reviews/
-- 2026-09-16-prf-02-slice-6-owner-decisions.md, decision 3, written into
-- FULL-PRODUCT-DEFINITION.md §6's own module table. Task record:
-- bharatstudio-requirements/active/tasks/PRF-02-safe-mode.md. That
-- decision is the whole authorisation for this migration and is not
-- restated here.
--
-- WHAT SAFE MODE IS. A creator switch. While it is on, a newly created
-- alert delivery for that channel is written with status = 'held'
-- instead of status = 'ready', so it waits for the creator or a
-- moderator instead of reaching the overlay.
--
-- WHAT IT IS NOT, AND THIS IS THE LOAD-BEARING HALF:
--
--   * IT IS NEVER AUTOMATIC. No spike detector, no rejection-rate
--     heuristic, no volume threshold, no time window, no signal of any
--     kind turns it on or off. There is not a single number in this
--     migration that decides when safe mode engages, because choosing
--     one would be making a product decision the owner explicitly has
--     not made. packages/db/tests/prf02_safe_mode.sql case SM.11
--     asserts that against pg_get_functiondef -- no interval, no
--     aggregate, no rate, no threshold token -- rather than against this
--     comment.
--
--   * IT IS NOT alert_queues.is_paused. That flag is a QUEUE LIFECYCLE
--     state and stays exactly what it is. This migration never reads it,
--     never writes it, never renames it and never surfaces it under a
--     safe-mode label. The overlay read's definition is asserted against
--     that token in packages/db/tests/prf02_slice5_moderator_status.sql
--     case S5.5, which this work extends rather than deletes.
--
-- THE STATE IS A COLUMN ON public.channels, NOT A NEW TABLE. Every
-- durable, single-valued, always-present, creator-toggled state in this
-- schema is already a boolean column on the row it belongs to --
-- alert_queues.is_paused (0001 L57), channels.accepting_tips (0001),
-- channels.featured_consent (0072 L26). Safe mode has that exact shape:
-- one bit of current state, no content, no lifecycle, no history any
-- authority asks for. A row-per-channel table would have needed an
-- absence-means-off convention, a second write path to create the row,
-- and a join on the delivery insert path -- the hottest write in the
-- product. stream_missions (0135) got its own table because a mission is
-- a record with content and a lifecycle; this is not that.
--
-- The column is additive and defaulted, so every existing channel reads
-- false and behaves exactly as it did before this migration existed.
-- Nothing is backfilled because there is nothing to backfill.
--
-- ONE PLACE DECIDES THE STATUS, THREE PLACES ASK IT. Before this
-- migration, the literal 'ready' was hard-coded at THREE live insert
-- sites:
--
--     app_private.create_manual_alert              0019 L86
--     app_private.record_verified_payment_webhook  0028 L247
--     app_private.record_youtube_alert_event       0117 L483
--
-- There is no shared helper they pass through, so "where the status is
-- first assigned" is three places. This migration re-declares all three
-- with that literal replaced by a call to
-- app_private.initial_delivery_status(), which is now the only thing in
-- the schema that decides whether a delivery starts ready or held.
--
-- A BEFORE INSERT TRIGGER WAS CONSIDERED AND REJECTED. It would have
-- been fifteen lines instead of five hundred -- and it would have been a
-- FOURTH place, silently overriding three literals that still read
-- 'ready'. That is precisely the "second place that can disagree" this
-- work was told not to create. The three function bodies below were
-- extracted mechanically from their source migrations rather than
-- retyped (one of them is the verified-payment-webhook path, where a
-- transcription slip is a money bug); the only textual differences from
-- the definitions they replace are two local declarations, two
-- assignments, hold_reason joining the insert's column list, and the
-- status expression itself.
--
-- THE HOLD REASON IS THE EXISTING 'moderation', NOT A NEW ONE.
-- event_outbox_deliveries.hold_reason is constrained to
-- ('moderation', 'operator') (0062 L13). A safe-mode hold is a delivery
-- awaiting a moderator's decision, which is what 'moderation' already
-- means -- and it is what makes the existing release path work
-- unchanged: app_private.apply_moderation_action(..., 'approve')
-- releases held deliveries whose hold_reason = 'moderation' (0062
-- L117-L120). Adding a 'safe_mode' reason would have meant widening that
-- CHECK constraint AND teaching the approve path about it, duplicating
-- the held path instead of reusing it. THE CONSTRAINT IS UNTOUCHED.
--
-- NO DISPATCHER CHANGE WAS NEEDED, AND THAT WAS VERIFIED BEFORE THIS WAS
-- WRITTEN. 'held' is already excluded from app_private.
-- claim_event_delivery and app_private.list_ready_event_deliveries
-- (0062: status in ('pending', 'ready', 'failed_retriable')), and
-- app_private.refresh_event_outbox_status (0015 L28) already treats a
-- held delivery as keeping its outbox 'pending'. So routing a new
-- delivery to 'held' is sufficient on its own: it is never leased, never
-- dispatched, never displayed. Case SM.5 asserts that rather than
-- assuming it.
--
-- TURNING SAFE MODE OFF RELEASES NOTHING. Switching it off changes the
-- routing of NEWLY CREATED deliveries only. Every delivery already
-- sitting at 'held' stays 'held', keeps hold_reason = 'moderation', and
-- is reviewed one at a time through the existing per-event
-- app_private.apply_moderation_action path -- exactly as a manually held
-- delivery always has been. NO BULK RELEASE IS BUILT AND NONE IS
-- DECIDED: auto-releasing a backlog on toggle-off would fire an unknown
-- number of unreviewed alerts onto a live broadcast the instant a
-- creator flips a switch, irreversible once played, and nobody has
-- decided that behaviour. Cases SM.6 and SM.7 prove both halves.
--
-- NO PAYMENT, OUTBOX OR DELIVERY ROW IS DELETED OR REWRITTEN. A
-- safe-mode hold changes a NEW delivery's initial status; it never drops
-- a delivery, never fails a payment, and never removes money state.
-- 'held' is already a first-class state of the existing machine (0001
-- L134). Append-only semantics are preserved.
--
-- TIER. None. §12.6: storing, viewing and changing a durable creator
-- record is available at every tier, and safe mode is a moderation
-- control, not a rendering feature. §30.3's module cap (0131) governs
-- only whether the Canvas RENDERS the Moderator Status Card. There is no
-- tier check in any function below. The only gate is the role gate
-- app_private.has_channel_role(channel, ['owner','admin']) -- the same
-- one app_private.skip_payout_onboarding (0079) uses.
--
-- THE OVERLAY READ GROWS BY EXACTLY ONE BOOLEAN. PostgreSQL cannot
-- change a function's OUT columns with `create or replace`, so
-- list_overlay_moderator_status is dropped and re-created below -- the
-- same mechanic 0127 used for get_overlay_events. §6's "never private
-- content" stays a property of the query: a boolean is not a supporter,
-- a message or an amount, and the returned column set is still asserted
-- by exact string in packages/db/tests/prf02_slice5_moderator_status.sql
-- (case S5.4, EXTENDED to the new declared type, never deleted).
--
-- ROLLBACK. Re-apply 0019, 0028, 0117 and 0136's function bodies, then
--   alter table public.channels drop column safe_mode_enabled;
--   drop function app_private.initial_delivery_status(uuid);
--   drop function app_private.initial_delivery_hold_reason(text);
--   drop function app_private.set_channel_safe_mode(uuid, uuid, boolean);
--   drop function app_private.get_channel_safe_mode(uuid);
-- The column is additive and defaulted, so dropping it restores the
-- previous behaviour exactly. NO PRODUCTION MIGRATION WITHOUT SEPARATE
-- EXPLICIT APPROVAL.

-- ---------------------------------------------------------------------
-- The state.
-- ---------------------------------------------------------------------
alter table public.channels
  add column if not exists safe_mode_enabled boolean not null default false;

comment on column public.channels.safe_mode_enabled is
  'PRF-02 safe mode (§6 module #12): a creator switch. While true, newly created alert deliveries for this channel are written held rather than ready, for the creator or a moderator to review. Never automatic, never set by any signal, and NOT alert_queues.is_paused.';

-- ---------------------------------------------------------------------
-- The single decision point. This is the only thing in the schema that
-- decides whether a new delivery starts ready or held.
--
-- It reads ONE boolean off ONE primary-key row and returns one of two
-- string literals. There is no count, no window, no interval, no rate
-- and no threshold, and there never may be one without a fresh owner
-- decision -- safe mode is never automatic.
--
-- IT FAILS OPEN. A channel row that cannot be found yields 'ready'. That
-- is deliberate: the alternative is a payment webhook unable to create a
-- delivery at all, which turns a missing row into lost money state. A
-- delivery that should have been held and was not is recoverable through
-- the existing moderation path; a delivery that was never created is
-- not.
-- ---------------------------------------------------------------------
create or replace function app_private.initial_delivery_status(
  target_channel_id uuid
)
returns text
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select case
           when coalesce(
                  (select channel.safe_mode_enabled
                     from public.channels channel
                    where channel.id = target_channel_id),
                  false)
           then 'held'
           else 'ready'
         end
$$;

revoke execute on function app_private.initial_delivery_status(uuid) from public;
grant execute on function app_private.initial_delivery_status(uuid) to bsa_app;
grant execute on function app_private.initial_delivery_status(uuid) to bsa_payment;

-- ---------------------------------------------------------------------
-- The hold reason that goes with that status, mapped in ONE place so the
-- three insert sites cannot disagree about it either.
--
-- 'moderation' is the EXISTING reason from 0062's CHECK constraint, not
-- a new one, and it is what makes app_private.apply_moderation_action's
-- 'approve' branch release a safe-mode hold with no change to that
-- function at all.
-- ---------------------------------------------------------------------
create or replace function app_private.initial_delivery_hold_reason(
  target_status text
)
returns text
language sql
immutable
set search_path = pg_catalog, public, app_private
as $$
  select case when target_status = 'held' then 'moderation' else null end
$$;

revoke execute on function app_private.initial_delivery_hold_reason(text) from public;
grant execute on function app_private.initial_delivery_hold_reason(text) to bsa_app;
grant execute on function app_private.initial_delivery_hold_reason(text) to bsa_payment;

-- app_private.create_manual_alert
-- Re-declared from packages/db/migrations/0019_v1_l03_manual_alert_deliveries.sql, extracted mechanically
-- rather than retyped. The ONLY changes are: two local declarations, the two
-- assignments immediately before the insert, hold_reason joining the column
-- list, and the literal 'ready' becoming local_initial_status. Everything else
-- is byte-identical to the definition this replaces.
create or replace function app_private.create_manual_alert(
  target_event_id uuid,
  target_outbox_id uuid,
  target_channel_id uuid,
  target_user_id uuid,
  target_trace_id text,
  target_config_snapshot_version bigint,
  target_payload jsonb
)
returns table (event_id uuid, trace_id text)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  local_initial_status text;
  local_initial_hold_reason text;
  selected_queue record;
  requested_ids jsonb := target_payload -> 'queueIds';
  delivery_count integer := 0;
begin
  if target_user_id <> app_private.current_user_id() then
    raise exception 'actor mismatch' using errcode = '42501';
  end if;
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin', 'operator', 'moderator']::text[]) then
    raise exception 'channel access denied' using errcode = '42501';
  end if;
  if not (target_payload ? 'queueIds') or jsonb_typeof(requested_ids) <> 'array' or jsonb_array_length(requested_ids) = 0 then
    raise exception 'manual alert requires at least one queue' using errcode = '22023';
  end if;
  if exists (
    select 1
      from jsonb_array_elements_text(requested_ids) selected(value)
     where not exists (
       select 1 from public.alert_queues queue
        where queue.id::text = selected.value
          and queue.channel_id = target_channel_id
          and queue.closed_at is null
     )
  ) then
    raise exception 'manual alert queue selection is invalid' using errcode = '42501';
  end if;

  insert into public.alert_events (id, channel_id, payment_id, source_type, source_id, trace_id, config_snapshot_version, payload, created_at)
  values (target_event_id, target_channel_id, null, 'manual', target_event_id::text, target_trace_id, target_config_snapshot_version, target_payload, current_timestamp);

  insert into public.event_outbox (id, event_id, status, available_at, created_at, updated_at)
  values (target_outbox_id, target_event_id, 'pending', current_timestamp, current_timestamp, current_timestamp);

  for selected_queue in
    select queue.id as queue_id,
           coalesce(binding.id, md5('manual-binding:' || target_event_id::text || ':' || queue.id::text)::uuid) as binding_id,
           coalesce(binding.priority, 0) as source_priority,
           coalesce(binding.override_values, '{}'::jsonb) as override_values
      from public.alert_queues queue
      left join lateral (
        select candidate.id, candidate.priority, candidate.override_values
          from public.queue_bindings candidate
         where candidate.channel_id = target_channel_id
           and candidate.queue_id = queue.id
           and candidate.closed_at is null
           and candidate.source_type = 'manual'
           and candidate.source_id = target_event_id::text
         order by candidate.priority desc, candidate.created_at asc, candidate.id asc
         limit 1
      ) binding on true
     where queue.channel_id = target_channel_id
       and queue.closed_at is null
       and queue.id::text in (select distinct value from jsonb_array_elements_text(requested_ids))
     order by source_priority desc, queue.created_at asc, queue.id asc
  loop
    delivery_count := delivery_count + 1;
    local_initial_status := app_private.initial_delivery_status(target_channel_id);
    local_initial_hold_reason := app_private.initial_delivery_hold_reason(local_initial_status);
    insert into public.event_outbox_deliveries (
      id, event_id, outbox_id, queue_id, binding_id, source_id,
      config_snapshot_version, delivery_sequence, source_priority, override_values,
      status, hold_reason, attempt_count, created_at, updated_at
    )
    values (
      md5('manual-delivery:' || target_event_id::text || ':' || selected_queue.queue_id::text)::uuid,
      target_event_id, target_outbox_id, selected_queue.queue_id, selected_queue.binding_id, target_event_id::text,
      target_config_snapshot_version, delivery_count, selected_queue.source_priority, selected_queue.override_values,
      local_initial_status, local_initial_hold_reason, 0, current_timestamp, current_timestamp
    );
  end loop;

  if delivery_count = 0 then
    raise exception 'manual alert has no active queues' using errcode = '22023';
  end if;
  return query select target_event_id, target_trace_id;
end
$$;

revoke execute on function app_private.create_manual_alert(uuid, uuid, uuid, uuid, text, bigint, jsonb) from public;
grant execute on function app_private.create_manual_alert(uuid, uuid, uuid, uuid, text, bigint, jsonb) to bsa_app;

-- app_private.record_verified_payment_webhook
-- Re-declared from packages/db/migrations/0028_v1_l04_capture_projection_dedup.sql, extracted mechanically
-- rather than retyped. The ONLY changes are: two local declarations, the two
-- assignments immediately before the insert, hold_reason joining the column
-- list, and the literal 'ready' becoming local_initial_status. Everything else
-- is byte-identical to the definition this replaces.
create or replace function app_private.record_verified_payment_webhook(
  target_delivery_id uuid,
  target_environment text,
  target_connected_account_ref text,
  target_provider_event_id text,
  target_raw_body_hash text,
  target_signature_verified_at timestamptz,
  target_received_at timestamptz,
  target_normalized jsonb,
  target_payment_id uuid,
  target_refund_id uuid,
  target_alert_event_id uuid,
  target_outbox_id uuid,
  target_delivery_rows jsonb
)
returns table (
  duplicate boolean,
  quarantined boolean,
  payment_id uuid,
  alert_event_id uuid,
  delivery_status text
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  local_initial_status text;
  local_initial_hold_reason text;
  normalized_event text := target_normalized ->> 'event';
  normalized_type text := target_normalized ->> 'entityType';
  normalized_entity_id text := target_normalized ->> 'entityId';
  normalized_payment_id text := target_normalized ->> 'paymentId';
  normalized_order_id text := target_normalized ->> 'orderId';
  normalized_currency text := target_normalized ->> 'currency';
  normalized_status text := target_normalized ->> 'status';
  normalized_amount bigint := nullif(target_normalized ->> 'amountPaise', '')::bigint;
  normalized_refund_amount bigint := nullif(target_normalized ->> 'refundAmount', '')::bigint;
  local_payment_id uuid;
  local_channel_id uuid;
  local_intent payment_order_intents%rowtype;
  existing_delivery_id uuid;
  local_alert_event_id uuid;
  local_outbox_id uuid;
  delivery_count integer := 0;
  delivery jsonb;
  payment_status text;
  refund_status text;
begin
  if target_environment not in ('test', 'live')
     or target_connected_account_ref is null
     or target_provider_event_id is null
     or length(target_provider_event_id) = 0
     or target_normalized is null
     or normalized_event is null
     or normalized_type not in ('payment', 'refund', 'subscription', 'dispute')
     or normalized_entity_id is null
     or target_delivery_id is null
     or target_signature_verified_at is null
     or target_received_at is null then
    raise exception 'invalid normalized payment webhook' using errcode = '22023';
  end if;

  insert into public.payment_webhook_deliveries (
    id, provider, environment, connected_account_ref, provider_event_id,
    provider_event_name, entity_type, entity_id, raw_body_hash,
    signature_verified_at, received_at, processing_status
  )
  values (
    target_delivery_id, 'razorpay', target_environment, target_connected_account_ref,
    target_provider_event_id, normalized_event, normalized_type, normalized_entity_id,
    target_raw_body_hash, target_signature_verified_at, target_received_at, 'received'
  )
  on conflict (provider, environment, connected_account_ref, provider_event_id)
  do nothing
  returning id into existing_delivery_id;

  if existing_delivery_id is null then
    return query select true, false, null::uuid, null::uuid, 'duplicate';
    return;
  end if;

  if normalized_type = 'payment' then
    if normalized_payment_id is null or normalized_order_id is null or normalized_amount is null or normalized_amount < 1000 or normalized_currency <> 'INR' then
      update public.payment_webhook_deliveries
         set processing_status = 'quarantined'
       where id = target_delivery_id;
      return query select false, true, null::uuid, null::uuid, 'quarantined';
      return;
    end if;

    select intent.*
      into local_intent
      from public.payment_order_intents intent
     where intent.provider = 'razorpay'
       and intent.environment = target_environment
       and intent.connected_account_ref = target_connected_account_ref
       and intent.provider_order_id = normalized_order_id
     limit 1;

    if not found
       or local_intent.gross_amount_paise <> normalized_amount
       or local_intent.currency <> normalized_currency then
      update public.payment_webhook_deliveries
         set processing_status = 'quarantined'
       where id = target_delivery_id;
      return query select false, true, null::uuid, null::uuid, 'quarantined';
      return;
    end if;

    local_channel_id := local_intent.channel_id;
    select payment.id
      into local_payment_id
      from public.payments payment
     where payment.provider = 'razorpay'
       and payment.provider_payment_id = normalized_payment_id
     limit 1;

    payment_status := case
      when normalized_event in ('payment.captured', 'order.paid') then 'captured'
      when normalized_event = 'payment.failed' then 'failed'
      when normalized_event = 'payment.authorized' then 'pending'
      else 'pending'
    end;

    if local_payment_id is null then
      local_payment_id := target_payment_id;
      if local_payment_id is null then
        raise exception 'payment local id required' using errcode = '22023';
      end if;
      insert into public.payments (
        id, channel_id, provider, provider_payment_id, provider_order_id,
        gross_amount_paise, currency, status, environment, connected_account_ref,
        created_at, updated_at
      )
      values (
        local_payment_id, local_channel_id, 'razorpay', normalized_payment_id,
        normalized_order_id, normalized_amount, normalized_currency, payment_status,
        target_environment, target_connected_account_ref, current_timestamp, current_timestamp
      );
    else
      update public.payments payment
         set status = case
                       when payment.status in ('refunded', 'partially_refunded') then payment.status
                       when payment_status = 'captured' then 'captured'
                       when payment.status = 'captured' then payment.status
                       else payment_status
                     end,
             updated_at = current_timestamp
       where payment.id = local_payment_id;
    end if;

    if payment_status = 'captured' then
      update public.payment_order_intents
         set status = 'paid', updated_at = current_timestamp
       where id = local_intent.id;

      if local_intent.alert_consent then
        -- Razorpay documents `order.paid` and `payment.captured` as two
        -- event types for the same captured payment. The delivery IDs are
        -- intentionally recorded separately, but the business payment must
        -- create only one alert/outbox effect. A prior captured projection is
        -- complete because this function writes it atomically.
        select event.id
          into local_alert_event_id
          from public.alert_events event
         where event.payment_id = local_payment_id
         order by event.created_at asc, event.id asc
         limit 1;

        if local_alert_event_id is null then
          if target_alert_event_id is null or target_outbox_id is null then
            update public.payment_webhook_deliveries
               set processing_status = 'quarantined'
             where id = target_delivery_id;
            return query select false, true, local_payment_id, null::uuid, 'quarantined';
            return;
          end if;

          local_alert_event_id := target_alert_event_id;
          local_outbox_id := target_outbox_id;
          insert into public.alert_events (
            id, channel_id, payment_id, source_type, source_id, trace_id,
            config_snapshot_version, payload, created_at
          )
          values (
            local_alert_event_id, local_channel_id, local_payment_id, 'payment',
            normalized_payment_id, 'razorpay:' || target_provider_event_id,
            coalesce(nullif(target_delivery_rows -> 0 ->> 'configSnapshotVersion', '')::bigint, 1),
            target_normalized || jsonb_build_object(
              'displayName', local_intent.donor_display_name,
              'message', local_intent.donor_message
            ), current_timestamp
          );

          insert into public.event_outbox (id, event_id, status, available_at, created_at, updated_at)
          values (local_outbox_id, local_alert_event_id, 'pending', current_timestamp, current_timestamp, current_timestamp);

          for delivery in select value from jsonb_array_elements(coalesce(target_delivery_rows, '[]'::jsonb)) loop
            if not (delivery ? 'sourcePriority') or not (delivery ? 'overrideValues') then
              raise exception 'payment delivery routing snapshot missing' using errcode = '22023';
            end if;
            if not exists (
              select 1
                from public.queue_bindings binding
               where binding.id = (delivery ->> 'bindingId')::uuid
                 and binding.channel_id = local_channel_id
                 and binding.closed_at is null
                 and binding.source_type = 'payment'
                 and binding.source_id in (normalized_payment_id, '__channel_default__')
                 and not (
                   binding.source_id = '__channel_default__'
                   and exists (
                     select 1
                       from public.queue_bindings exact_binding
                      where exact_binding.channel_id = local_channel_id
                        and exact_binding.closed_at is null
                        and exact_binding.source_type = 'payment'
                        and exact_binding.source_id = normalized_payment_id
                   )
                 )
                 and binding.queue_id = (delivery ->> 'queueId')::uuid
                 and binding.priority = (delivery ->> 'sourcePriority')::integer
                 and coalesce(binding.override_values, 'null'::jsonb) = coalesce(delivery -> 'overrideValues', 'null'::jsonb)
            ) then
              raise exception 'payment delivery binding mismatch' using errcode = '42501';
            end if;

            local_initial_status := app_private.initial_delivery_status(local_channel_id);
            local_initial_hold_reason := app_private.initial_delivery_hold_reason(local_initial_status);
            insert into public.event_outbox_deliveries (
              id, event_id, outbox_id, queue_id, binding_id, source_id,
              config_snapshot_version, delivery_sequence, source_priority, override_values,
              status, hold_reason, attempt_count,
              created_at, updated_at
            )
            values (
              (delivery ->> 'deliveryId')::uuid, local_alert_event_id, local_outbox_id,
              (delivery ->> 'queueId')::uuid, (delivery ->> 'bindingId')::uuid,
              normalized_payment_id,
              (delivery ->> 'configSnapshotVersion')::bigint,
              (delivery ->> 'deliverySequence')::bigint,
              (delivery ->> 'sourcePriority')::integer,
              delivery -> 'overrideValues',
              local_initial_status, local_initial_hold_reason, 0, current_timestamp, current_timestamp
            );
            delivery_count := delivery_count + 1;
          end loop;

          if delivery_count = 0 then
            update public.event_outbox
               set status = 'quarantined', updated_at = current_timestamp
             where id = local_outbox_id;
            update public.payment_webhook_deliveries
               set processing_status = 'quarantined'
             where id = target_delivery_id;
            return query select false, true, local_payment_id, local_alert_event_id, 'quarantined';
            return;
          end if;
        end if;
      end if;
    end if;

    update public.payment_webhook_deliveries
       set processing_status = 'processed'
     where id = target_delivery_id;
    return query select false, false, local_payment_id, local_alert_event_id, 'processed';
    return;
  end if;

  if normalized_type = 'refund' then
    if normalized_payment_id is null or normalized_refund_amount is null or normalized_refund_amount <= 0 then
      update public.payment_webhook_deliveries
         set processing_status = 'quarantined'
       where id = target_delivery_id;
      return query select false, true, null::uuid, null::uuid, 'quarantined';
      return;
    end if;

    select payment.id, payment.channel_id
      into local_payment_id, local_channel_id
      from public.payments payment
     where payment.provider = 'razorpay'
       and payment.provider_payment_id = normalized_payment_id
       and payment.environment = target_environment
       and payment.connected_account_ref = target_connected_account_ref
     limit 1;

    if not found or target_refund_id is null then
      update public.payment_webhook_deliveries
         set processing_status = 'quarantined'
       where id = target_delivery_id;
      return query select false, true, local_payment_id, null::uuid, 'quarantined';
      return;
    end if;

    refund_status := case
      when normalized_event = 'refund.processed' then 'processed'
      when normalized_event = 'refund.failed' then 'failed'
      else 'requested'
    end;
    insert into public.refunds (
      id, payment_id, provider_refund_id, amount_paise, status, created_at, updated_at
    )
    values (
      target_refund_id, local_payment_id, normalized_entity_id,
      normalized_refund_amount, refund_status, current_timestamp, current_timestamp
    )
    on conflict (provider_refund_id) do nothing;

    if refund_status = 'processed' then
      update public.payments payment
         set status = case
                       when coalesce((select sum(refund.amount_paise) from public.refunds refund where refund.payment_id = payment.id and refund.status = 'processed'), 0) >= payment.gross_amount_paise then 'refunded'
                       else 'partially_refunded'
                     end,
             updated_at = current_timestamp
       where payment.id = local_payment_id;
    end if;

    update public.payment_webhook_deliveries
       set processing_status = 'processed'
     where id = target_delivery_id;
    return query select false, false, local_payment_id, null::uuid, 'processed';
    return;
  end if;

  update public.payment_webhook_deliveries
     set processing_status = 'quarantined'
   where id = target_delivery_id;
  return query select false, true, null::uuid, null::uuid, 'quarantined';
end
$$;

revoke execute on function app_private.record_verified_payment_webhook(uuid, text, text, text, text, timestamptz, timestamptz, jsonb, uuid, uuid, uuid, uuid, jsonb) from public;
grant execute on function app_private.record_verified_payment_webhook(uuid, text, text, text, text, timestamptz, timestamptz, jsonb, uuid, uuid, uuid, uuid, jsonb) to bsa_payment;

-- app_private.record_youtube_alert_event
-- Re-declared from packages/db/migrations/0117_v1_l16c_external_contribution_aggregation.sql, extracted mechanically
-- rather than retyped. The ONLY changes are: two local declarations, the two
-- assignments immediately before the insert, hold_reason joining the column
-- list, and the literal 'ready' becoming local_initial_status. Everything else
-- is byte-identical to the definition this replaces.
create or replace function app_private.record_youtube_alert_event(
  target_event_id uuid,
  target_outbox_id uuid,
  target_channel_id uuid,
  target_source_id text,
  target_source_event_type text,
  target_source_user_id text,
  target_trace_id text,
  target_config_snapshot_version bigint,
  target_payload jsonb
)
returns table (event_id uuid, inserted boolean, delivery_count integer)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  local_initial_status text;
  local_initial_hold_reason text;
  local_event_id uuid;
  local_delivery_count integer := 0;
  selected_binding record;
  contribution_amount bigint;
  contribution_currency text;
begin
  if target_event_id is null or target_outbox_id is null or target_channel_id is null
     or target_source_id is null or length(target_source_id) = 0 then
    raise exception 'invalid youtube alert event' using errcode = '22023';
  end if;

  insert into public.alert_events (
    id, channel_id, payment_id, source_type, source_id,
    source_event_type, source_user_id,
    trace_id, config_snapshot_version, payload, created_at
  )
  values (
    target_event_id, target_channel_id, null, 'youtube', target_source_id,
    target_source_event_type, target_source_user_id,
    target_trace_id, target_config_snapshot_version, target_payload, current_timestamp
  )
  on conflict (channel_id, source_type, source_id)
    where source_type in ('youtube', 'twitch', 'kick')
  do nothing
  returning id into local_event_id;

  if local_event_id is null then
    select id into local_event_id
      from public.alert_events
     where channel_id = target_channel_id and source_type = 'youtube' and source_id = target_source_id;
    return query select local_event_id, false, 0;
    return;
  end if;

  -- L16c addition: a genuinely new Super Chat, reported in INR, also
  -- becomes an external_contributions row. See file header for why only
  -- INR is accepted (minor unit = paise, no conversion invented) and why
  -- every other event type/currency is left exactly as before (alert only,
  -- no contribution — a real, documented gap, not a silent drop: it never
  -- raises, it simply does not insert).
  if target_source_event_type = 'youtube.super_chat' then
    contribution_currency := upper(target_payload->>'currency');
    if contribution_currency = 'INR' and (target_payload->>'amountMinorUnits') is not null then
      contribution_amount := (target_payload->>'amountMinorUnits')::bigint;
      if contribution_amount >= 1 then
        insert into public.external_contributions (
          id, channel_id, source_type, source_id, alert_event_id, gross_amount_paise, source_currency, created_at
        )
        values (
          gen_random_uuid(), target_channel_id, 'youtube_superchat', target_source_id, local_event_id,
          contribution_amount, 'INR', current_timestamp
        )
        on conflict (channel_id, source_type, source_id) do nothing;
      end if;
    end if;
  end if;

  insert into public.event_outbox (id, event_id, status, available_at, created_at, updated_at)
  values (target_outbox_id, local_event_id, 'pending', current_timestamp, current_timestamp, current_timestamp);

  for selected_binding in
    select binding.id as binding_id,
           binding.queue_id as queue_id,
           binding.priority as source_priority,
           coalesce(binding.override_values, '{}'::jsonb) as override_values,
           binding.created_at as created_at
      from public.queue_bindings binding
     where binding.channel_id = target_channel_id
       and binding.closed_at is null
       and binding.source_type = 'youtube'
       and binding.source_id in (target_source_id, '__channel_default__')
       and not (
         binding.source_id = '__channel_default__'
         and exists (
           select 1
             from public.queue_bindings exact_binding
            where exact_binding.channel_id = target_channel_id
              and exact_binding.closed_at is null
              and exact_binding.source_type = 'youtube'
              and exact_binding.source_id = target_source_id
              and exact_binding.queue_id = binding.queue_id
         )
       )
     order by binding.priority desc, binding.created_at asc, binding.id asc
  loop
    local_delivery_count := local_delivery_count + 1;
    local_initial_status := app_private.initial_delivery_status(target_channel_id);
    local_initial_hold_reason := app_private.initial_delivery_hold_reason(local_initial_status);
    insert into public.event_outbox_deliveries (
      id, event_id, outbox_id, queue_id, binding_id, source_id,
      config_snapshot_version, delivery_sequence, source_priority, override_values,
      status, hold_reason, attempt_count, created_at, updated_at
    )
    values (
      md5('youtube-delivery:' || local_event_id::text || ':' || selected_binding.queue_id::text)::uuid,
      local_event_id, target_outbox_id, selected_binding.queue_id, selected_binding.binding_id, target_source_id,
      target_config_snapshot_version, local_delivery_count, selected_binding.source_priority, selected_binding.override_values,
      local_initial_status, local_initial_hold_reason, 0, current_timestamp, current_timestamp
    );
  end loop;

  if local_delivery_count = 0 then
    update public.event_outbox
       set status = 'quarantined', updated_at = current_timestamp
     where id = target_outbox_id;
  end if;

  return query select local_event_id, true, local_delivery_count;
end
$$;

revoke execute on function app_private.record_youtube_alert_event(uuid, uuid, uuid, text, text, text, text, bigint, jsonb) from public;
grant execute on function app_private.record_youtube_alert_event(uuid, uuid, uuid, text, text, text, text, bigint, jsonb) to bsa_connector_poller;

-- ---------------------------------------------------------------------
-- CREATOR WRITE: turn safe mode on, turn it off.
--
-- The gate is app_private.has_channel_role(channel, ['owner','admin']) --
-- the SAME gate app_private.skip_payout_onboarding (0079 L37) uses for
-- the same kind of durable channel setting. NOT a tier check: §12.6
-- forbids tier-gating a durable creator record, and safe mode is a
-- moderation control, not a rendering feature.
--
-- It takes a BOOLEAN, not an action name, so "turn it on" and "turn it
-- off" are the same code path and cannot drift apart. It is idempotent:
-- setting the value it already has is a no-op that raises nothing.
--
-- There is no reason parameter, no duration parameter, no expiry
-- parameter and no scheduled-off parameter. Safe mode has no knobs; it
-- has a switch. Every one of those would have been a product decision
-- nobody made.
-- ---------------------------------------------------------------------
create or replace function app_private.set_channel_safe_mode(
  target_channel_id uuid,
  target_user_id uuid,
  target_enabled boolean
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  result boolean;
begin
  if target_user_id is null
     or target_enabled is null
     or target_user_id <> app_private.current_user_id()
     or not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'invalid safe-mode change' using errcode = '42501';
  end if;

  perform 1 from public.channels channel
   where channel.id = target_channel_id and channel.closed_at is null;
  if not found then
    raise exception 'channel not found' using errcode = '42501';
  end if;

  update public.channels
     set safe_mode_enabled = target_enabled, updated_at = current_timestamp
   where id = target_channel_id
  returning safe_mode_enabled into result;

  return result;
end
$$;

revoke execute on function app_private.set_channel_safe_mode(uuid, uuid, boolean) from public;
grant execute on function app_private.set_channel_safe_mode(uuid, uuid, boolean) to bsa_app;

-- ---------------------------------------------------------------------
-- CREATOR READ: the current state.
--
-- Zero rows for a caller without the role, exactly as
-- app_private.list_channel_stream_mission (0135 L221) answers -- so a
-- non-member and a non-existent channel are the same indistinguishable
-- answer, and the route maps both to 404 rather than a 403 that would
-- confirm the channel exists.
--
-- Same owner/admin gate as the write. A role that may not change safe
-- mode is not shown whether it is on, because "alerts are being held" is
-- itself moderation state.
-- ---------------------------------------------------------------------
create or replace function app_private.get_channel_safe_mode(
  target_channel_id uuid
)
returns table (enabled boolean)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select channel.safe_mode_enabled
    from public.channels channel
   where channel.id = target_channel_id
     and app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[])
$$;

revoke execute on function app_private.get_channel_safe_mode(uuid) from public;
grant execute on function app_private.get_channel_safe_mode(uuid) to bsa_app;

-- ---------------------------------------------------------------------
-- THE OVERLAY READ, EXTENDED BY EXACTLY ONE BOOLEAN.
--
-- This replaces 0136's two-argument function of the same name. Its
-- held-count half is byte-identical to 0136's; the only addition is
-- safe_mode. PostgreSQL cannot change OUT columns with `create or
-- replace`, so it is dropped and re-created -- the same mechanic 0127
-- used for get_overlay_events. Nothing else about the function changes:
-- same overlay_sessions token-fingerprint / revoked_at / expires_at
-- gate, same outer-FROM shape, same security-definer posture, same
-- grants.
--
-- EVERYTHING 0136 SAID ABOUT THIS FUNCTION STILL HOLDS, and is not
-- repeated here except where safe mode changes it:
--
--   * AN INVALID SESSION STILL RETURNS ZERO ROWS, NOT A ROW OF
--     FALSE/ZERO. overlay_sessions is still the outer FROM and both
--     values are still scalar subqueries in the select list. A bad token
--     produces no row at all, which the client renders as "no answer" --
--     distinct from a real answer of "nothing held, safe mode off".
--
--   * QUEUE LIFECYCLE STILL DOES NOT FILTER THE COUNT. Held deliveries
--     are still counted across every queue of the channel, paused and
--     closed included. Pausing and closing are queue lifecycle states;
--     held is a delivery state.
--
--   * THE PAUSED FLAG IS STILL NEVER READ. Safe mode having arrived does
--     NOT make alert_queues.is_paused publishable: it remains a
--     different thing, and the token does not appear in this definition.
--     packages/db/tests/prf02_slice5_moderator_status.sql case S5.5
--     asserts that against pg_get_functiondef, and now also asserts the
--     positive -- this definition MUST read safe_mode_enabled -- so a
--     build that silently dropped the flag fails by name.
--
-- "NEVER PRIVATE CONTENT" (§6) IS STILL A PROPERTY OF THIS QUERY. The
-- projection is one integer and one boolean. No supporter name, message
-- text, amount, delivery id, event id, queue id, payment reference or
-- viewer identifier is selected, joined out or returned, and none can be
-- added without changing this declared `returns table` signature -- which
-- case S5.4 asserts by exact string, from the catalogue AND from a table
-- materialised out of a live call. §12.7 is satisfied by construction:
-- two scalars cannot grow into a list.
--
-- safe_mode is coalesced to false. The channel row is guaranteed by the
-- overlay_sessions foreign key, so the coalesce is belt to that braces --
-- but a null reaching the client would fail its own type guard and hide
-- the card, which is a worse answer than "off".
-- ---------------------------------------------------------------------
drop function if exists app_private.list_overlay_moderator_status(uuid, text);

create function app_private.list_overlay_moderator_status(
  target_overlay_id uuid,
  target_token_fingerprint text
)
returns table (held_count bigint, safe_mode boolean)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select (
           select count(*)
             from public.event_outbox_deliveries delivery
             join public.alert_queues queue on queue.id = delivery.queue_id
            where queue.channel_id = session.channel_id
              and delivery.status = 'held'
         )::bigint as held_count,
         coalesce(
           (
             select channel.safe_mode_enabled
               from public.channels channel
              where channel.id = session.channel_id
           ),
           false
         ) as safe_mode
    from public.overlay_sessions session
   where session.id = target_overlay_id
     and session.token_fingerprint = target_token_fingerprint
     and session.revoked_at is null
     and session.expires_at > current_timestamp
$$;

revoke execute on function app_private.list_overlay_moderator_status(uuid, text) from public;
grant execute on function app_private.list_overlay_moderator_status(uuid, text) to bsa_app;
