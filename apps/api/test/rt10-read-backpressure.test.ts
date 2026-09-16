import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import type { RuntimeConfig } from '../src/config.js';
import { classifyReadPriority } from '../src/domain/read-priority.js';
import { createReadBackpressureGovernor } from '../src/domain/read-backpressure.js';
import type { OverlayGoalStore } from '../src/domain/goal-store.js';
import type { PublicChannelRepository } from '../src/domain/public-channel.js';
import type { PaymentOrderService } from '../src/domain/payment-order.js';

const config: RuntimeConfig = { nodeEnv: 'test', host: '127.0.0.1', port: 4100, appOrigin: 'http://localhost:3100', paymentEnvironment: 'test' };

// --- RT-10.1/RT-10.3: classification -------------------------------------

test('RT-10.1/RT-10.3: classifyReadPriority is GET-only, and an unnamed GET route fails safe toward the lower (derived_read) priority', () => {
  // Named widget/dashboard/analytics surfaces: governed.
  assert.equal(classifyReadPriority('GET', '/v1/overlay-goals/:overlayId'), 'derived_read');
  assert.equal(classifyReadPriority('GET', '/v1/channels/:channelId/payments'), 'derived_read');
  // Named durable/payment-adjacent reads: exempt, explicitly.
  assert.equal(classifyReadPriority('GET', '/v1/overlays/:overlayId/events'), 'exempt');
  assert.equal(classifyReadPriority('GET', '/v1/public/tip-orders/:orderId/status'), 'exempt');
  assert.equal(classifyReadPriority('GET', '/internal/metrics'), 'exempt');
  // RT-10.3: a route this module has never seen before must fail toward
  // the LOWER priority (governed), not be silently treated as exempt.
  assert.equal(classifyReadPriority('GET', '/v1/some-new-surface-nobody-classified-yet'), 'derived_read');
});

test('RT-10.4: every non-GET request is structurally outside the governed class, regardless of route — payments, webhooks, alert delivery and overlay events are POST/PUT/DELETE in this API and are therefore never shed', () => {
  assert.equal(classifyReadPriority('POST', '/v1/public/channels/:handle/tips/orders'), null);
  assert.equal(classifyReadPriority('POST', '/v1/channels/:channelId/test-alert'), null);
  assert.equal(classifyReadPriority('PUT', '/v1/overlays/:overlayId/rotate'), null);
  assert.equal(classifyReadPriority('DELETE', '/v1/channels/:channelId/payment-accounts'), null);
});

// --- RT-10 governor: unit ---------------------------------------------

test('RT-10: unset ceiling never sheds (kill switch = today\'s behaviour)', () => {
  const governor = createReadBackpressureGovernor({});
  for (let i = 0; i < 50; i += 1) {
    const admission = governor.tryAdmit();
    assert.equal(admission.admitted, true);
  }
});

test('RT-10.1/RT-10.2: a configured ceiling sheds once at capacity, and a released slot frees capacity for the next request', () => {
  const outcomes: string[] = [];
  const governor = createReadBackpressureGovernor({ maxConcurrentDerivedReads: 1 }, (o) => outcomes.push(o));
  const first = governor.tryAdmit();
  assert.equal(first.admitted, true);
  const second = governor.tryAdmit();
  assert.equal(second.admitted, false); // shed: capacity was already used by `first`.
  assert.deepEqual(outcomes, ['admitted', 'shed']);
  if (first.admitted) first.release();
  const third = governor.tryAdmit();
  assert.equal(third.admitted, true, 'releasing the first admission frees capacity for the next request');
});

test('RT-10: tryAdmit never throws and never performs I/O — a metrics callback failure cannot break admission', () => {
  const governor = createReadBackpressureGovernor({ maxConcurrentDerivedReads: 5 }, () => {
    throw new Error('metrics backend exploded');
  });
  assert.doesNotThrow(() => governor.tryAdmit());
});

// --- RT-10 integration: a real governed route sheds, a real exempt/payment
// route never does, even under the same ceiling ------------------------

const goal = {
  schemaVersion: 'v1' as const, goalId: '00000000-0000-4000-8000-000000000021', title: 'Goal',
  targetAmountPaise: 100000, window: 'stream' as const, progressPaise: 5000, reached: false,
};

test('RT-10.1/RT-10.2: a widget-read burst cannot exhaust a ceiling shared with nothing else — the second concurrent governed read is shed with a clear retryable 503, never a hang', async () => {
  let releaseFirst: (() => void) | undefined;
  const overlayGoals: OverlayGoalStore = {
    async getForOverlay() {
      // Held open until the test explicitly releases it, so the second
      // concurrent request is guaranteed to observe the ceiling at capacity.
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      return goal;
    },
  };
  const app = await buildApp(config, {
    overlayGoals,
    readBackpressureGovernor: createReadBackpressureGovernor({ maxConcurrentDerivedReads: 1 }),
  });

  const firstRequest = app.inject({ method: 'GET', url: '/v1/overlay-goals/00000000-0000-4000-8000-000000000030', headers: { authorization: 'Bearer ' + 't'.repeat(32) } });
  // Give the first request's handler a tick to register admission before firing the second.
  await new Promise((resolve) => setTimeout(resolve, 10));

  const shedResponse = await app.inject({ method: 'GET', url: '/v1/overlay-goals/00000000-0000-4000-8000-000000000031', headers: { authorization: 'Bearer ' + 't'.repeat(32) } });
  assert.equal(shedResponse.statusCode, 503, 'shed while the first governed read is still in flight');
  const body = shedResponse.json();
  assert.equal(body.errorCode, 'derived_read_shed');
  assert.equal(body.retryable, true, 'RT-10.2: a shed read must be explicitly retryable');
  assert.ok(shedResponse.headers['retry-after'], 'RT-10.2: a clear retry signal, never a silent hang');

  assert.ok(releaseFirst);
  releaseFirst?.();
  const firstResponse = await firstRequest;
  assert.equal(firstResponse.statusCode, 200, 'the first (already-admitted) request completes normally');

  await app.close();
});

test('RT-10.4: a payment-order write is never shed, even while the derived-read ceiling is fully exhausted', async () => {
  const publicChannels: PublicChannelRepository = {
    async findByHandle(handle) {
      return { channelId: '00000000-0000-4000-8000-000000000040', handle, displayName: 'Creator', acceptingTips: true, minimumTipPaise: 1000, publicConfigVersion: 1 };
    },
    async resolveReleasedHandle() { return null; },
    async listFeatured() { return []; },
  };
  const paymentOrders: PaymentOrderService = {
    async createTipOrder() {
      return {
        schemaVersion: 'v1', orderId: '00000000-0000-4000-8000-000000000041', provider: 'razorpay',
        providerOrderId: 'order_1', amountPaise: 10000, currency: 'INR', status: 'created',
      };
    },
  };
  // The ceiling is 0 — every derived_read request would be shed unconditionally,
  // so if this write were ever routed through the governor it would 503 too.
  const governor = createReadBackpressureGovernor({ maxConcurrentDerivedReads: 0 });
  const app = await buildApp(config, { publicChannels, paymentOrders, readBackpressureGovernor: governor });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/public/channels/creator/tips/orders',
    headers: { 'idempotency-key': 'a'.repeat(32) },
    payload: { amountPaise: 10000, currency: 'INR', donorDisplayName: 'Supporter', message: null, alertConsent: true },
  });
  assert.equal(response.statusCode, 201, 'the write itself succeeds — proves it was never intercepted by the governor');
  assert.notEqual(response.statusCode, 503, 'a payment-order write must never be shed by the derived-read governor');

  await app.close();
});
