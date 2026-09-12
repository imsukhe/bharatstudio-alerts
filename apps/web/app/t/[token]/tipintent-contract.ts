// Parses GET /v1/public/tip-intents/:token responses (routes/public.ts).
// Mirrors ../../tips/[handle]/tip-contract.ts's "only trust exactly the
// keys we expect, in exactly the shape we expect" style — a response with
// an unexpected extra field is treated as untrusted, not partially used.

export type TipIntentReady = {
  state: 'ready';
  channelHandle: string;
  channelDisplayName: string;
  amountPaise: number;
  currency: 'INR';
  donorDisplayName: string | null;
  message: string | null;
};

export type TipIntentUsedOrExpired = {
  state: 'used' | 'expired';
  channelHandle: string;
  channelDisplayName: string;
};

export type TipIntentUnknown = { state: 'unknown' };

export type TipIntentResponse = TipIntentReady | TipIntentUsedOrExpired | TipIntentUnknown;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isNullableBoundedString(value: unknown, maxLength: number): value is string | null {
  return value === null || (typeof value === 'string' && value.length <= maxLength);
}

export function parseTipIntentResponse(value: unknown): TipIntentResponse | null {
  if (!isRecord(value) || value.schemaVersion !== 'v1' || typeof value.state !== 'string') return null;

  if (value.state === 'unknown') {
    return hasOnlyKeys(value, new Set(['schemaVersion', 'state', 'errorCode', 'message', 'traceId'])) ? { state: 'unknown' } : null;
  }

  if (value.state === 'used' || value.state === 'expired') {
    if (!hasOnlyKeys(value, new Set(['schemaVersion', 'state', 'channelHandle', 'channelDisplayName']))) return null;
    if (typeof value.channelHandle !== 'string' || typeof value.channelDisplayName !== 'string') return null;
    return { state: value.state, channelHandle: value.channelHandle, channelDisplayName: value.channelDisplayName };
  }

  if (value.state === 'ready') {
    if (!hasOnlyKeys(value, new Set(['schemaVersion', 'state', 'channelHandle', 'channelDisplayName', 'amountPaise', 'currency', 'donorDisplayName', 'message']))) return null;
    if (typeof value.channelHandle !== 'string' || typeof value.channelDisplayName !== 'string') return null;
    if (typeof value.amountPaise !== 'number' || !Number.isSafeInteger(value.amountPaise) || value.amountPaise < 100) return null;
    if (value.currency !== 'INR') return null;
    if (!isNullableBoundedString(value.donorDisplayName, 80) || !isNullableBoundedString(value.message, 500)) return null;
    return {
      state: 'ready',
      channelHandle: value.channelHandle,
      channelDisplayName: value.channelDisplayName,
      amountPaise: value.amountPaise,
      currency: 'INR',
      donorDisplayName: value.donorDisplayName,
      message: value.message,
    };
  }

  return null;
}
