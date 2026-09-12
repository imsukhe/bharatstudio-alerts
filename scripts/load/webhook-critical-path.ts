// L09 load/failure harness — drives the REAL webhook transaction boundary,
// not a reimplementation of it.
//
// `submitVerifiedPaymentWebhook` below issues the exact SQL call
// `services/payment-webhook-go/internal/ingress/sql_store.go`'s
// `PersistVerified` makes to `app_private.record_verified_payment_webhook`
// (packages/db/migrations/0028_v1_l04_capture_projection_dedup.sql) — same
// function, same argument order, same delivery-routing computation
// (`resolveDeliveryRows` mirrors that file's `queueRows` CTE exactly). The
// only things this harness does NOT exercise are: the Go HTTP handler and
// Razorpay signature verification (this harness calls the persistence layer
// directly, bypassing HTTP), Cloud Tasks dispatch, and the private
// alert-worker Go binary. Overlay listing/ack goes through the real
// `createSqlOverlayStore` from apps/api/src/db/overlay-store.ts — same code
// the API route calls. See load-harness.ts's file-level comment for the
// full "what this can/cannot prove" statement.
//
// Synthetic data only. No real payment provider, tokens, or personal data.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import type { SeededWorld } from '../fixtures/alerts-fixture.js';
import { createSqlOverlayStore } from '../../apps/api/src/db/overlay-store.js';

const RAZORPAY_ENVIRONMENT = 'test' as const;

export interface CheckoutIntent {
  intentId: string;
  paymentAccountId: string;
  channelId: string;
  connectedAccountRef: string;
  providerOrderId: string;
  grossAmountPaise: number;
}

export interface SubmittedWebhookResult {
  duplicate: boolean;
  quarantined: boolean;
  paymentId: string | null;
  alertEventId: string | null;
  deliveryStatus: string;
  providerEventId: string;
  providerPaymentId: string;
}

// Ensures a payment_account row exists for the channel (upsert — safe to
// call once per world, cheap to call every tip).
export async function ensurePaymentAccount(sql: Sql, channelId: string, connectedAccountRef: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into payment_accounts (id, channel_id, provider, environment, connected_account_ref, status, created_at, updated_at)
    values (${randomUUID()}::uuid, ${channelId}::uuid, 'razorpay', ${RAZORPAY_ENVIRONMENT}, ${connectedAccountRef}, 'active', current_timestamp, current_timestamp)
    on conflict (channel_id, provider, environment) do update set updated_at = current_timestamp
    returning id
  `;
  const id = rows[0]?.id;
  if (!id) throw new Error('ensurePaymentAccount: no row returned');
  return id;
}

// Creates a fresh checkout intent (the real pre-webhook state: a viewer
// opened a TipIntent and Razorpay created an order). One per simulated tip
// — provider_order_id/idempotency_key/provider_receipt are all unique per
// call so concurrent tips never collide on the intent's own unique
// constraints (packages/db/migrations/0006_v1_l04_payment_order_intents.sql).
export async function seedCheckoutIntent(
  sql: Sql,
  world: Pick<SeededWorld, 'channelId'>,
  paymentAccountId: string,
  connectedAccountRef: string,
  grossAmountPaise = 5000,
): Promise<CheckoutIntent> {
  const intentId = randomUUID();
  const suffix = randomBytes(8).toString('hex');
  const providerOrderId = `order_load_${suffix}`;
  const rows = await sql<{ id: string }[]>`
    insert into payment_order_intents (
      id, channel_id, payment_account_id, provider, environment, connected_account_ref,
      idempotency_key, provider_receipt, provider_order_id, gross_amount_paise, currency,
      donor_display_name, donor_message, alert_consent, status, provider_created_at,
      expires_at, created_at, updated_at
    )
    values (
      ${intentId}::uuid, ${world.channelId}::uuid, ${paymentAccountId}::uuid, 'razorpay', ${RAZORPAY_ENVIRONMENT}, ${connectedAccountRef},
      ${`load-idem-${suffix}`}, ${`load-receipt-${suffix}`}, ${providerOrderId}, ${grossAmountPaise}, 'INR',
      'Load Test Viewer', 'synthetic load-test tip', true, 'provider_created', current_timestamp,
      current_timestamp + interval '10 minutes', current_timestamp, current_timestamp
    )
    returning id
  `;
  const id = rows[0]?.id;
  if (!id) throw new Error('seedCheckoutIntent: no row returned');
  return { intentId: id, paymentAccountId, channelId: world.channelId, connectedAccountRef, providerOrderId, grossAmountPaise };
}

// Mirrors queueRows() in services/payment-webhook-go/internal/ingress/
// sql_store.go verbatim (same CTE, same route-selection predicate) so the
// delivery-routing snapshot handed to the SQL function is identical to what
// the real Go service would compute for the same channel/payment.
export async function resolveDeliveryRows(sql: Sql, channelId: string, providerPaymentId: string): Promise<Array<{
  deliveryId: string; queueId: string; bindingId: string; allowDuplicates: boolean;
  configSnapshotVersion: number; deliverySequence: number; sourcePriority: number; overrideValues: unknown;
}>> {
  const rows = await sql<{
    binding_id: string; queue_id: string; allow_duplicates: boolean; config_snapshot_version: string;
    route_order: string; priority: number; override_values: unknown;
  }[]>`
    with candidates as (
      select binding.id::text as binding_id,
             binding.queue_id::text as queue_id,
             binding.allow_duplicates,
             coalesce(config.version, 1) as config_snapshot_version,
             row_number() over (order by binding.priority desc, binding.created_at asc, binding.id asc) as route_order,
             count(*) over () as route_count,
             bool_and(binding.allow_duplicates) over () as all_allow_duplicates,
             binding.priority,
             binding.override_values
        from queue_bindings binding
        join alert_queues queue on queue.id = binding.queue_id
                                   and queue.channel_id = binding.channel_id
                                   and queue.closed_at is null
        left join lateral (
           select version from channel_configs where channel_id = binding.channel_id order by version desc limit 1
        ) config on true
       where binding.channel_id = ${channelId}::uuid
         and binding.closed_at is null
         and binding.source_type = 'payment'
         and binding.source_id in (${providerPaymentId}, '__channel_default__')
         and not (
           binding.source_id = '__channel_default__'
           and exists (
             select 1 from queue_bindings exact_binding
              where exact_binding.channel_id = ${channelId}::uuid
                and exact_binding.closed_at is null
                and exact_binding.source_type = 'payment'
                and exact_binding.source_id = ${providerPaymentId}
           )
         )
    )
    select binding_id, queue_id, allow_duplicates, config_snapshot_version, route_order, priority, override_values
      from candidates
     where route_count = 1 or all_allow_duplicates or route_order = 1
     order by route_order
  `;
  return rows.map((row) => ({
    deliveryId: randomUUID(),
    queueId: row.queue_id,
    bindingId: row.binding_id,
    allowDuplicates: row.allow_duplicates,
    configSnapshotVersion: Number(row.config_snapshot_version),
    deliverySequence: Number(row.route_order),
    sourcePriority: row.priority,
    overrideValues: row.override_values,
  }));
}

export interface SubmitOptions {
  providerEventId: string;
  providerPaymentId: string;
  intent: CheckoutIntent;
  eventName?: 'payment.captured' | 'order.paid';
}

// The single call this whole harness exists to exercise: the same
// `app_private.record_verified_payment_webhook` invocation the Go payment
// webhook service issues on a verified inbound webhook.
export async function submitVerifiedPaymentWebhook(sql: Sql, opts: SubmitOptions): Promise<SubmittedWebhookResult> {
  const { providerEventId, providerPaymentId, intent } = opts;
  const eventName = opts.eventName ?? 'payment.captured';
  const deliveryRows = await resolveDeliveryRows(sql, intent.channelId, providerPaymentId);
  const normalized = {
    event: eventName,
    entityType: 'payment',
    entityId: providerPaymentId,
    paymentId: providerPaymentId,
    orderId: intent.providerOrderId,
    amountPaise: intent.grossAmountPaise,
    currency: 'INR',
    status: 'captured',
    refundAmount: null,
    planId: null,
    currentStart: null,
    currentEnd: null,
    chargeAt: null,
  };
  const deliveryId = randomUUID();
  const alertEventId = randomUUID();
  const outboxId = randomUUID();
  const rawBodyHash = createHash('sha256').update(`synthetic-load:${providerEventId}`, 'utf8').digest('hex');

  const rows = await sql<{ duplicate: boolean; quarantined: boolean; payment_id: string | null; alert_event_id: string | null; delivery_status: string }[]>`
    select duplicate, quarantined, payment_id::text as payment_id, alert_event_id::text as alert_event_id, delivery_status
      from app_private.record_verified_payment_webhook(
        ${deliveryId}::uuid, ${RAZORPAY_ENVIRONMENT}, ${intent.connectedAccountRef}, ${providerEventId}, ${rawBodyHash},
        current_timestamp, current_timestamp, ${sql.json(normalized)}::jsonb,
        nullif(${randomUUID()}, '')::uuid, nullif('', '')::uuid,
        nullif(${alertEventId}, '')::uuid, nullif(${outboxId}, '')::uuid, ${sql.json(deliveryRows)}::jsonb
      )
  `;
  const result = rows[0];
  if (!result) throw new Error('submitVerifiedPaymentWebhook: no row returned');
  return {
    duplicate: result.duplicate,
    quarantined: result.quarantined,
    paymentId: result.payment_id,
    alertEventId: result.alert_event_id,
    deliveryStatus: result.delivery_status,
    providerEventId,
    providerPaymentId,
  };
}

// Real overlay listing + acknowledgement — same functions the API's
// GET .../overlay/:overlayId/events and POST .../ack routes call
// (apps/api/src/routes/overlay.ts -> apps/api/src/db/overlay-store.ts).
// Matches the delivery by trace_id, which the SQL function sets to
// `razorpay:<providerEventId>` — a stable key independent of any locally
// generated delivery/alert-event id.
// Deletes rows this module creates that alerts-fixture.ts's teardownWorld
// does not know about (it predates the webhook-critical-path flow). Must
// run BEFORE teardownWorld: event_outbox/event_outbox_deliveries/
// event_processing_attempts reference alert_events with no ON DELETE
// CASCADE (packages/db/migrations/0001_v1_baseline.sql), and
// payment_accounts/payment_order_intents reference channels(id) — either
// left in place would make teardownWorld's own deletes fail on a foreign
// key violation, not merely leak rows.
export async function teardownCheckoutArtifacts(sql: Sql, channelId: string, connectedAccountRef: string, overlayId?: string): Promise<void> {
  // acknowledgeDeliveryForEvent (below) calls the real ack_overlay_cursor
  // function, which writes overlay_cursors rows. teardownWorld deletes
  // overlay_sessions but not overlay_cursors (it predates the ack flow this
  // harness exercises) — overlay_cursors.overlay_session_id references
  // overlay_sessions(id) with no cascade, so it must be cleared first.
  if (overlayId) {
    await sql`delete from overlay_cursors where overlay_session_id = ${overlayId}::uuid`;
  }
  await sql`delete from event_processing_attempts where delivery_id in (select id from event_outbox_deliveries where event_id in (select id from alert_events where channel_id = ${channelId}::uuid))`;
  await sql`delete from event_outbox_deliveries where event_id in (select id from alert_events where channel_id = ${channelId}::uuid)`;
  await sql`delete from event_outbox where event_id in (select id from alert_events where channel_id = ${channelId}::uuid)`;
  await sql`delete from payment_order_intents where channel_id = ${channelId}::uuid`;
  await sql`delete from payment_accounts where channel_id = ${channelId}::uuid`;
  await sql`delete from payment_webhook_deliveries where connected_account_ref = ${connectedAccountRef}`;
}

export async function acknowledgeDeliveryForEvent(
  sql: Sql,
  overlayId: string,
  overlayToken: string,
  providerEventId: string,
): Promise<'acknowledged' | 'not_found'> {
  const store = createSqlOverlayStore(sql, 'https://overlay.load-test.invalid');
  const events = await store.replay(overlayToken, overlayId, undefined, 100);
  const traceId = `razorpay:${providerEventId}`;
  const match = events?.find((event) => event.traceId === traceId);
  if (!match) return 'not_found';
  const ok = await store.acknowledge(overlayToken, overlayId, match.cursor, match.eventId);
  return ok ? 'acknowledged' : 'not_found';
}
