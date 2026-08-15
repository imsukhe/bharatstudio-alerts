export type TipOrderResponse = {
  schemaVersion: 'v1';
  orderId: string;
  provider: 'razorpay';
  providerOrderId: string;
  amountPaise: number;
  currency: 'INR';
  status: 'created' | 'pending';
};

export type PublicOrderStatus = {
  schemaVersion: 'v1';
  orderId: string;
  status: 'pending' | 'paid' | 'expired' | 'failed';
  amountPaise: number;
  currency: 'INR';
  updatedAt: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isSafeAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1000;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export function parseTipOrderResponse(value: unknown, expectedAmountPaise: number): TipOrderResponse | null {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['schemaVersion', 'orderId', 'provider', 'providerOrderId', 'amountPaise', 'currency', 'status'])) || value.schemaVersion !== 'v1' || !isUuid(value.orderId) || value.provider !== 'razorpay' || typeof value.providerOrderId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.providerOrderId)) return null;
  if (value.status !== 'created' && value.status !== 'pending') return null;
  if (!isSafeAmount(value.amountPaise) || value.amountPaise !== expectedAmountPaise || value.currency !== 'INR') return null;
  return { schemaVersion: 'v1', orderId: value.orderId, provider: 'razorpay', providerOrderId: value.providerOrderId, amountPaise: value.amountPaise, currency: 'INR', status: value.status };
}

export function parsePublicOrderStatus(value: unknown): PublicOrderStatus | null {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['schemaVersion', 'orderId', 'status', 'amountPaise', 'currency', 'updatedAt'])) || value.schemaVersion !== 'v1' || !isUuid(value.orderId) || !['pending', 'paid', 'expired', 'failed'].includes(String(value.status)) || !isSafeAmount(value.amountPaise) || value.currency !== 'INR' || !isIsoDate(value.updatedAt)) return null;
  return { schemaVersion: 'v1', orderId: value.orderId, status: value.status as PublicOrderStatus['status'], amountPaise: value.amountPaise, currency: 'INR', updatedAt: value.updatedAt };
}

export function boundedServerMessage(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 180 ? value : undefined;
}
