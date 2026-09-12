import { GoogleAuth, type IdTokenClient } from 'google-auth-library';
import type { Sql } from 'postgres';
import {
  PaymentMethodUpdateForbiddenError,
  type PaymentMethodUpdateLink,
  type PaymentMethodUpdateService,
  type RequestPaymentMethodUpdateLinkInput,
} from '../domain/billing-payment-method.js';

// Kept short so a leaked/logged link cannot be replayed later. Mirrors the
// non-negotiable boundary in docs/BharatStudio-MASTER-PLAN.md#1.4:
// BharatStudio never touches instrument data, so the only thing this
// endpoint can ever return is an opaque, time-boxed handoff into
// Razorpay's own hosted flow.
const MAX_LINK_LIFETIME_MS = 30 * 60 * 1000;

type Transport = (client: IdTokenClient, url: string, body: RequestPaymentMethodUpdateLinkInput, traceId: string) => Promise<unknown>;

function normalizeTraceId(traceId: string): string {
  const normalized = traceId.trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(normalized)) throw new Error('invalid internal trace id');
  return normalized;
}

function assertLink(value: unknown): PaymentMethodUpdateLink {
  if (!value || typeof value !== 'object') throw new Error('invalid payment service response');
  const response = value as Record<string, unknown>;
  const allowed = new Set(['schemaVersion', 'provider', 'updateUrl', 'expiresAt']);
  if (
    !Object.keys(response).every((key) => allowed.has(key)) ||
    response.schemaVersion !== 'v1' ||
    response.provider !== 'razorpay' ||
    typeof response.updateUrl !== 'string' ||
    typeof response.expiresAt !== 'string'
  ) {
    throw new Error('invalid payment service response');
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(response.updateUrl);
  } catch {
    throw new Error('invalid payment service response');
  }
  // Opaque and short-lived: https only, no embedded credentials, and no
  // query string at all — a mutable amount/plan/tier must never ride
  // along in a client-visible parameter on this link.
  if (parsedUrl.protocol !== 'https:' || parsedUrl.username !== '' || parsedUrl.password !== '' || parsedUrl.search !== '') {
    throw new Error('invalid payment service response');
  }
  const expiresAtMs = new Date(response.expiresAt).getTime();
  if (Number.isNaN(expiresAtMs)) throw new Error('invalid payment service response');
  const lifetimeMs = expiresAtMs - Date.now();
  if (lifetimeMs <= 0 || lifetimeMs > MAX_LINK_LIFETIME_MS) throw new Error('invalid payment service response');
  return { schemaVersion: 'v1', provider: 'razorpay', updateUrl: response.updateUrl, expiresAt: response.expiresAt };
}

export function createBillingPaymentMethodService(
  sql: Sql,
  origin: string,
  audience: string,
  nodeEnv: 'development' | 'test' | 'staging' | 'production',
  transport: Transport = async (client, url, body, traceId) => {
    const response = await client.request({ method: 'POST', url, data: body, headers: { 'content-type': 'application/json', 'idempotency-key': body.idempotencyKey, 'x-bsa-trace-id': traceId }, timeout: 10_000 });
    return response.data;
  },
  clientFactory?: () => Promise<IdTokenClient>,
): PaymentMethodUpdateService {
  const parsed = new URL(origin);
  if ((nodeEnv === 'staging' || nodeEnv === 'production') && parsed.protocol !== 'https:') throw new Error('PAYMENT_SERVICE_ORIGIN must use HTTPS outside development');
  if (!audience.trim()) throw new Error('PAYMENT_SERVICE_AUDIENCE is required when payment service is configured');
  const auth = new GoogleAuth();
  let clientPromise: Promise<IdTokenClient> | undefined;
  const getClient = async () => {
    clientPromise ??= clientFactory ? clientFactory() : auth.getIdTokenClient(audience);
    return clientPromise;
  };
  const url = `${parsed.origin}/internal/v1/subscriptions/payment-method`;
  return {
    async requestUpdateLink(input, traceId = 'api-request') {
      // Role gate lives here, at the DB boundary, ahead of ever calling
      // the payment service — reuses the same app_private.has_channel_role
      // security-definer function the L03 role-scoped financial reads
      // already rely on (packages/db/migrations/0039), so no new migration
      // is needed for this check.
      const rows = await sql.begin(async (tx) => {
        await tx`select set_config('app.user_id', ${input.userId}, true)`;
        return tx<{ has_role: boolean }[]>`
          select app_private.has_channel_role(${input.channelId}::uuid, array['owner', 'admin']::text[]) as has_role
        `;
      });
      if (!rows[0]?.has_role) throw new PaymentMethodUpdateForbiddenError();
      const client = await getClient();
      const response = await transport(client, url, input, normalizeTraceId(traceId));
      return assertLink(response);
    },
  };
}
