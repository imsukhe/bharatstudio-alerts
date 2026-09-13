import assert from 'node:assert/strict';
import test from 'node:test';
import { createGoogleDynamicQrService } from '../src/db/payment-provider-razorpay-qr-client.js';
import type { CreateDynamicQrInput } from '../src/domain/payment-provider-creator.js';

const fakeIdTokenClient = {} as any;

test('createDynamicQr posts to /internal/v1/tips/qr with the request body and trace header, and validates the response', async () => {
  let seenUrl = '';
  let seenBody: CreateDynamicQrInput | undefined;
  let seenTraceId = '';
  const service = createGoogleDynamicQrService(
    'https://payment-webhook.internal.example',
    'https://payment-webhook.internal.example',
    'test',
    async (_client, url, body, traceId) => {
      seenUrl = url;
      seenBody = body;
      seenTraceId = traceId;
      return { schemaVersion: 'v1', provider: 'razorpay', providerQrRef: 'qr_prov_1', qrImageUrl: 'https://rzp.io/i/qr_prov_1.png', expiresAt: '2026-09-13T00:15:00.000Z', status: 'created' };
    },
    async () => fakeIdTokenClient,
  );

  const result = await service.createDynamicQr({ channelId: 'channel-1', environment: 'test', intentId: 'intent-1', closeBy: '2026-09-13T00:15:00.000Z' }, 'trace-1');

  assert.equal(seenUrl, 'https://payment-webhook.internal.example/internal/v1/tips/qr');
  assert.deepEqual(seenBody, { channelId: 'channel-1', environment: 'test', intentId: 'intent-1', closeBy: '2026-09-13T00:15:00.000Z' });
  assert.equal(seenTraceId, 'trace-1');
  assert.deepEqual(result, { schemaVersion: 'v1', provider: 'razorpay', providerQrRef: 'qr_prov_1', qrImageUrl: 'https://rzp.io/i/qr_prov_1.png', expiresAt: '2026-09-13T00:15:00.000Z' });
});

test('createDynamicQr rejects a response with a non-https image url', async () => {
  const service = createGoogleDynamicQrService(
    'https://payment-webhook.internal.example',
    'https://payment-webhook.internal.example',
    'test',
    async () => ({ schemaVersion: 'v1', provider: 'razorpay', providerQrRef: 'qr_prov_1', qrImageUrl: 'http://rzp.io/i/qr_prov_1.png', expiresAt: '2026-09-13T00:15:00.000Z', status: 'created' }),
    async () => fakeIdTokenClient,
  );
  await assert.rejects(() => service.createDynamicQr({ channelId: 'channel-1', environment: 'test', intentId: 'intent-1', closeBy: '2026-09-13T00:15:00.000Z' }));
});

test('createDynamicQr rejects a response with an unexpected extra field', async () => {
  const service = createGoogleDynamicQrService(
    'https://payment-webhook.internal.example',
    'https://payment-webhook.internal.example',
    'test',
    async () => ({ schemaVersion: 'v1', provider: 'razorpay', providerQrRef: 'qr_prov_1', qrImageUrl: 'https://rzp.io/i/qr_prov_1.png', expiresAt: '2026-09-13T00:15:00.000Z', status: 'created', unexpectedField: 'x' }),
    async () => fakeIdTokenClient,
  );
  await assert.rejects(() => service.createDynamicQr({ channelId: 'channel-1', environment: 'test', intentId: 'intent-1', closeBy: '2026-09-13T00:15:00.000Z' }));
});

test('createDynamicQr rejects an invalid trace id rather than forwarding it', async () => {
  const service = createGoogleDynamicQrService(
    'https://payment-webhook.internal.example',
    'https://payment-webhook.internal.example',
    'test',
    async () => ({ schemaVersion: 'v1', provider: 'razorpay', providerQrRef: 'qr_prov_1', qrImageUrl: 'https://rzp.io/i/qr_prov_1.png', expiresAt: '2026-09-13T00:15:00.000Z', status: 'created' }),
    async () => fakeIdTokenClient,
  );
  await assert.rejects(() => service.createDynamicQr({ channelId: 'channel-1', environment: 'test', intentId: 'intent-1', closeBy: '2026-09-13T00:15:00.000Z' }, 'bad trace id with spaces'));
});
