// L19d — signed client for the Go payment-webhook service's dynamic-QR
// endpoint (/internal/v1/tips/qr). Deliberately its own file rather than a
// second method on payment-order-client.ts's PaymentOrderService: QR
// creation is a different internal call, with a different request/response
// shape, to a different endpoint that never creates a TipOrder -- see
// domain/payment-provider-creator.ts's DynamicQrService for why this is not
// a widening of PaymentOrderService.
import { GoogleAuth, type IdTokenClient } from 'google-auth-library';
import type { CreateDynamicQrInput, CreateQrResult, DynamicQrService } from '../domain/payment-provider-creator.js';

type Transport = (client: IdTokenClient, url: string, body: CreateDynamicQrInput, traceId: string) => Promise<unknown>;

function normalizeTraceId(traceId: string): string {
  const normalized = traceId.trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(normalized)) throw new Error('invalid internal trace id');
  return normalized;
}

function isProviderIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128 && /^[\x21-\x7e]+$/.test(value);
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function isIsoDateString(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function assertQrResult(value: unknown): CreateQrResult {
  if (!value || typeof value !== 'object') throw new Error('invalid qr service response');
  const response = value as Record<string, unknown>;
  const allowed = new Set(['schemaVersion', 'provider', 'providerQrRef', 'qrImageUrl', 'expiresAt', 'status']);
  if (
    !Object.keys(response).every((key) => allowed.has(key))
    || response.schemaVersion !== 'v1'
    || response.provider !== 'razorpay'
    || !isProviderIdentifier(response.providerQrRef)
    || !isHttpsUrl(response.qrImageUrl)
    || !isIsoDateString(response.expiresAt)
    || (response.status !== 'created' && response.status !== 'pending')
  ) {
    throw new Error('invalid qr service response');
  }
  return {
    schemaVersion: 'v1',
    provider: 'razorpay',
    providerQrRef: response.providerQrRef,
    qrImageUrl: response.qrImageUrl,
    expiresAt: response.expiresAt,
  };
}

export function createGoogleDynamicQrService(
  origin: string,
  audience: string,
  nodeEnv: 'development' | 'test' | 'staging' | 'production',
  transport: Transport = async (client, url, body, traceId) => {
    const response = await client.request({ method: 'POST', url, data: body, headers: { 'content-type': 'application/json', 'x-bsa-trace-id': traceId }, timeout: 10_000 });
    return response.data;
  },
  clientFactory?: () => Promise<IdTokenClient>,
): DynamicQrService {
  const parsed = new URL(origin);
  if ((nodeEnv === 'staging' || nodeEnv === 'production') && parsed.protocol !== 'https:') throw new Error('PAYMENT_SERVICE_ORIGIN must use HTTPS outside development');
  if (!audience.trim()) throw new Error('PAYMENT_SERVICE_AUDIENCE is required when payment service is configured');
  const auth = new GoogleAuth();
  let clientPromise: Promise<IdTokenClient> | undefined;
  return {
    async createDynamicQr(input, traceId = 'api-request') {
      clientPromise ??= clientFactory ? clientFactory() : auth.getIdTokenClient(audience);
      const client = await clientPromise;
      const response = await transport(client, `${parsed.origin}/internal/v1/tips/qr`, input, normalizeTraceId(traceId));
      return assertQrResult(response);
    },
  };
}
