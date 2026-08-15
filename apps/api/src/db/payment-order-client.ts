import { GoogleAuth, type IdTokenClient } from 'google-auth-library';
import type { CreateTipOrderInput, PaymentOrderService, TipOrder } from '../domain/payment-order.js';

type Transport = (client: IdTokenClient, url: string, body: CreateTipOrderInput, traceId: string) => Promise<unknown>;

function normalizeTraceId(traceId: string): string {
  const normalized = traceId.trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(normalized)) throw new Error('invalid internal trace id');
  return normalized;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isProviderIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128 && /^[\x21-\x7e]+$/.test(value);
}

function isSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

function assertOrder(value: unknown, expectedAmount: number): TipOrder {
  if (!value || typeof value !== 'object') throw new Error('invalid payment service response');
  const response = value as Record<string, unknown>;
  const allowed = new Set(['schemaVersion', 'orderId', 'provider', 'providerOrderId', 'amountPaise', 'currency', 'status']);
  if (!Object.keys(response).every((key) => allowed.has(key)) || response.schemaVersion !== 'v1' || response.provider !== 'razorpay' || response.currency !== 'INR' || !isUuid(response.orderId) || !isProviderIdentifier(response.providerOrderId) || !isSafeInteger(response.amountPaise) || response.amountPaise !== expectedAmount || expectedAmount < 1_000 || (response.status !== 'created' && response.status !== 'pending')) {
    throw new Error('invalid payment service response');
  }
  return {
    schemaVersion: 'v1',
    orderId: response.orderId,
    provider: 'razorpay',
    providerOrderId: response.providerOrderId,
    amountPaise: expectedAmount,
    currency: 'INR',
    status: response.status,
  };
}

export function createGooglePaymentOrderService(
  origin: string,
  audience: string,
  nodeEnv: 'development' | 'test' | 'staging' | 'production',
  transport: Transport = async (client, url, body, traceId) => {
    const response = await client.request({ method: 'POST', url, data: body, headers: { 'content-type': 'application/json', 'idempotency-key': body.idempotencyKey, 'x-bsa-trace-id': traceId }, timeout: 10_000 });
    return response.data;
  },
  clientFactory?: () => Promise<IdTokenClient>,
): PaymentOrderService {
  const parsed = new URL(origin);
  if ((nodeEnv === 'staging' || nodeEnv === 'production') && parsed.protocol !== 'https:') throw new Error('PAYMENT_SERVICE_ORIGIN must use HTTPS outside development');
  if (!audience.trim()) throw new Error('PAYMENT_SERVICE_AUDIENCE is required when payment service is configured');
  const auth = new GoogleAuth();
  let clientPromise: Promise<IdTokenClient> | undefined;
  return {
    async createTipOrder(input, traceId = 'api-request') {
      clientPromise ??= clientFactory ? clientFactory() : auth.getIdTokenClient(audience);
      const client = await clientPromise;
      const response = await transport(client, `${parsed.origin}/internal/v1/tips/orders`, input, normalizeTraceId(traceId));
      return assertOrder(response, input.amountPaise);
    },
  };
}
