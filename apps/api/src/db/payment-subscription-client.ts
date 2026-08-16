import { GoogleAuth, type IdTokenClient } from 'google-auth-library';
import type {
  BillingSubscription,
  CancelSubscriptionInput,
  ChangeSubscriptionPlanInput,
  CreateBillingSubscriptionInput,
  PaymentSubscriptionService,
  ReactivateSubscriptionInput,
  SubscriptionLifecycleAction,
  SubscriptionLifecycleResult,
} from '../domain/payment-subscription.js';

type Transport = (client: IdTokenClient, url: string, body: CreateBillingSubscriptionInput, traceId: string) => Promise<unknown>;

type LifecycleRequestBody =
  | ({ action: 'cancel' } & CancelSubscriptionInput)
  | ({ action: 'upgrade' | 'downgrade' } & ChangeSubscriptionPlanInput)
  | ({ action: 'reactivate' } & ReactivateSubscriptionInput);

type LifecycleTransport = (client: IdTokenClient, url: string, body: LifecycleRequestBody, traceId: string) => Promise<unknown>;

function normalizeTraceId(traceId: string): string {
  const normalized = traceId.trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(normalized)) throw new Error('invalid internal trace id');
  return normalized;
}

function isProviderIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128 && /^[\x21-\x7e]+$/.test(value);
}

function isSafePositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function assertSubscription(value: unknown, input: CreateBillingSubscriptionInput): BillingSubscription {
  if (!value || typeof value !== 'object') throw new Error('invalid payment service response');
  const response = value as Record<string, unknown>;
  const allowed = new Set(['schemaVersion', 'provider', 'status', 'subscriptionId', 'tier', 'billingInterval', 'monthlyPricePaise', 'annualChargePaise', 'annualMonthsCharged', 'annualServiceMonths', 'checkoutUrl']);
  let checkoutUrlIsValid = response.checkoutUrl === null;
  if (typeof response.checkoutUrl === 'string') {
    try {
      const parsed = new URL(response.checkoutUrl);
      checkoutUrlIsValid = parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '';
    } catch {
      checkoutUrlIsValid = false;
    }
  }
  const normalizedCheckoutUrl = typeof response.checkoutUrl === 'string' ? response.checkoutUrl : null;
  if (!Object.keys(response).every((key) => allowed.has(key)) || response.schemaVersion !== 'v1' || response.provider !== 'razorpay' || (response.status !== 'linked' && response.status !== 'pending') || !isProviderIdentifier(response.subscriptionId) || response.tier !== input.tier || response.billingInterval !== input.billingInterval || !isSafePositiveInteger(response.monthlyPricePaise) || !isSafePositiveInteger(response.annualChargePaise) || response.annualChargePaise !== (response.monthlyPricePaise as number) * 10 || response.annualMonthsCharged !== 10 || response.annualServiceMonths !== 12 || !checkoutUrlIsValid) {
    throw new Error('invalid payment service response');
  }
  return {
    schemaVersion: 'v1',
    provider: 'razorpay',
    status: response.status,
    subscriptionId: response.subscriptionId,
    tier: input.tier,
    billingInterval: input.billingInterval,
    monthlyPricePaise: response.monthlyPricePaise,
    annualChargePaise: response.annualChargePaise,
    annualMonthsCharged: 10,
    annualServiceMonths: 12,
    checkoutUrl: normalizedCheckoutUrl,
  };
}

function assertLifecycleResult(value: unknown, action: SubscriptionLifecycleAction): SubscriptionLifecycleResult {
  if (!value || typeof value !== 'object') throw new Error('invalid payment service response');
  const response = value as Record<string, unknown>;
  const allowed = new Set(['schemaVersion', 'action', 'requestId', 'status', 'replay']);
  if (
    !Object.keys(response).every((key) => allowed.has(key)) ||
    response.schemaVersion !== 'v1' ||
    response.action !== action ||
    !isProviderIdentifier(response.requestId) ||
    (response.status !== 'requested' && response.status !== 'provider_confirmed' && response.status !== 'provider_failed') ||
    typeof response.replay !== 'boolean'
  ) {
    throw new Error('invalid payment service response');
  }
  return { schemaVersion: 'v1', action, requestId: response.requestId, status: response.status, replay: response.replay };
}

export function createGooglePaymentSubscriptionService(
  origin: string,
  audience: string,
  nodeEnv: 'development' | 'test' | 'staging' | 'production',
  transport: Transport = async (client, url, body, traceId) => {
    const response = await client.request({ method: 'POST', url, data: body, headers: { 'content-type': 'application/json', 'idempotency-key': body.idempotencyKey, 'x-bsa-trace-id': traceId }, timeout: 10_000 });
    return response.data;
  },
  clientFactory?: () => Promise<IdTokenClient>,
  lifecycleTransport: LifecycleTransport = async (client, url, body, traceId) => {
    const response = await client.request({ method: 'POST', url, data: body, headers: { 'content-type': 'application/json', 'idempotency-key': body.idempotencyKey, 'x-bsa-trace-id': traceId }, timeout: 10_000 });
    return response.data;
  },
): PaymentSubscriptionService {
  const parsed = new URL(origin);
  if ((nodeEnv === 'staging' || nodeEnv === 'production') && parsed.protocol !== 'https:') throw new Error('PAYMENT_SERVICE_ORIGIN must use HTTPS outside development');
  if (!audience.trim()) throw new Error('PAYMENT_SERVICE_AUDIENCE is required when payment service is configured');
  const auth = new GoogleAuth();
  let clientPromise: Promise<IdTokenClient> | undefined;
  const getClient = async () => {
    clientPromise ??= clientFactory ? clientFactory() : auth.getIdTokenClient(audience);
    return clientPromise;
  };
  const lifecycleUrl = `${parsed.origin}/internal/v1/subscriptions/lifecycle`;
  return {
    async createSubscription(input, traceId = 'api-request') {
      const client = await getClient();
      const response = await transport(client, `${parsed.origin}/internal/v1/subscriptions`, input, normalizeTraceId(traceId));
      return assertSubscription(response, input);
    },
    async cancelSubscription(input, traceId = 'api-request') {
      const client = await getClient();
      const response = await lifecycleTransport(client, lifecycleUrl, { action: 'cancel', ...input }, normalizeTraceId(traceId));
      return assertLifecycleResult(response, 'cancel');
    },
    async changeSubscriptionPlan(input, action, traceId = 'api-request') {
      const client = await getClient();
      const response = await lifecycleTransport(client, lifecycleUrl, { action, ...input }, normalizeTraceId(traceId));
      return assertLifecycleResult(response, action);
    },
    async reactivateSubscription(input, traceId = 'api-request') {
      const client = await getClient();
      const response = await lifecycleTransport(client, lifecycleUrl, { action: 'reactivate', ...input }, normalizeTraceId(traceId));
      return assertLifecycleResult(response, 'reactivate');
    },
  };
}
