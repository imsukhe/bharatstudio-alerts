import assert from 'node:assert/strict';
import test from 'node:test';
import { createRazorpayPaymentProvider } from '../src/domain/payment-provider-razorpay.js';
import { PaymentProviderNotImplementedError, type CreateQrResult, type CreateDynamicQrInput, type DynamicQrService } from '../src/domain/payment-provider-creator.js';

const channelId = '00000000-0000-4000-8000-000000000011';

function fakeQrService(result: CreateQrResult, calls: CreateDynamicQrInput[] = []): DynamicQrService {
  return {
    async createDynamicQr(input) {
      calls.push(input);
      return result;
    },
  };
}

test('createQr throws PaymentProviderNotImplementedError when no DynamicQrService is configured for this instance', async () => {
  const provider = createRazorpayPaymentProvider();
  await assert.rejects(
    () => provider.createQr({ channelId, environment: 'test', idempotencyKey: 'k', intentId: 'TIP_1', amountPaise: 1000, currency: 'INR', expiresAt: '2026-09-13T00:15:00.000Z' }),
    PaymentProviderNotImplementedError,
  );
});

test('createQr throws when the intent has no expiresAt, even with a DynamicQrService configured', async () => {
  const calls: CreateDynamicQrInput[] = [];
  const provider = createRazorpayPaymentProvider(undefined, undefined, fakeQrService({ schemaVersion: 'v1', provider: 'razorpay', providerQrRef: 'qr_1', qrImageUrl: 'https://rzp.io/i/qr_1.png', expiresAt: '2026-09-13T00:15:00.000Z' }, calls));
  await assert.rejects(
    () => provider.createQr({ channelId, environment: 'test', idempotencyKey: 'k', intentId: 'TIP_1', amountPaise: 1000, currency: 'INR' }),
    PaymentProviderNotImplementedError,
  );
  assert.equal(calls.length, 0, 'the provider must never be called for an intent missing expiresAt');
});

test('createQr delegates to the DynamicQrService with channelId/environment/intentId/closeBy and returns its result unchanged', async () => {
  const calls: CreateDynamicQrInput[] = [];
  const result: CreateQrResult = { schemaVersion: 'v1', provider: 'razorpay', providerQrRef: 'qr_prov_1', qrImageUrl: 'https://rzp.io/i/qr_prov_1.png', expiresAt: '2026-09-13T00:15:00.000Z' };
  const provider = createRazorpayPaymentProvider(undefined, undefined, fakeQrService(result, calls));

  const returned = await provider.createQr(
    { channelId, environment: 'test', idempotencyKey: 'k', intentId: 'TIP_1', amountPaise: 1000, currency: 'INR', expiresAt: '2026-09-13T00:15:00.000Z' },
    'trace-1',
  );

  assert.deepEqual(returned, result);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { channelId, environment: 'test', intentId: 'TIP_1', closeBy: '2026-09-13T00:15:00.000Z' });
});

test('capability reporting: supportsDynamicQr is true on the rail regardless of whether this instance was given a DynamicQrService', () => {
  const wired = createRazorpayPaymentProvider(undefined, undefined, fakeQrService({ schemaVersion: 'v1', provider: 'razorpay', providerQrRef: 'qr_1', qrImageUrl: 'https://rzp.io/i/qr_1.png', expiresAt: '2026-09-13T00:15:00.000Z' }));
  const unwired = createRazorpayPaymentProvider();
  assert.equal(wired.connectionCapabilities().supportsDynamicQr, true);
  assert.equal(unwired.connectionCapabilities().supportsDynamicQr, true);
});

test('refund and fetchPayment still throw regardless of createQr wiring — this task never touches them', async () => {
  const provider = createRazorpayPaymentProvider(undefined, undefined, fakeQrService({ schemaVersion: 'v1', provider: 'razorpay', providerQrRef: 'qr_1', qrImageUrl: 'https://rzp.io/i/qr_1.png', expiresAt: '2026-09-13T00:15:00.000Z' }));
  await assert.rejects(() => provider.fetchPayment('pay_1'), PaymentProviderNotImplementedError);
  await assert.rejects(() => provider.refund('pay_1', 1000), PaymentProviderNotImplementedError);
  assert.equal(provider.connectionCapabilities().supportsRefunds, false);
});
