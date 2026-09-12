// Parses GET /v1/public/receipts/:token responses (apps/api routes/viewer.ts).
// Same "only trust exactly the keys we expect" discipline as
// ../../t/[token]/tipintent-contract.ts. This page works with NO viewer
// account at all, so the response is deliberately the only source of
// truth — nothing here is ever derived from the token itself.

export type ReceiptFound = {
  state: 'found';
  channelHandle: string;
  channelDisplayName: string;
  grossAmountPaise: number;
  refundedAmountPaise: number;
  netAmountPaise: number;
  currency: 'INR';
  donorDisplayName: string | null;
  message: string | null;
  paymentStatus: string;
  paidAt: string;
};

export type ReceiptNotFound = { state: 'not_found' };

export type ReceiptResponse = ReceiptFound | ReceiptNotFound;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableBoundedString(value: unknown, maxLength: number): value is string | null {
  return value === null || (typeof value === 'string' && value.length <= maxLength);
}

function isSafeNonNegativeAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function parseReceiptResponse(value: unknown): ReceiptResponse | null {
  if (!isRecord(value) || value.schemaVersion !== 'v1') return null;

  if (typeof value.errorCode === 'string') {
    return { state: 'not_found' };
  }

  const receipt = value.receipt;
  if (!isRecord(receipt)) return null;
  if (typeof receipt.channelHandle !== 'string' || typeof receipt.channelDisplayName !== 'string') return null;
  if (!isSafeNonNegativeAmount(receipt.grossAmountPaise) || !isSafeNonNegativeAmount(receipt.refundedAmountPaise) || !isSafeNonNegativeAmount(receipt.netAmountPaise)) return null;
  if (receipt.currency !== 'INR') return null;
  if (!isNullableBoundedString(receipt.donorDisplayName, 80) || !isNullableBoundedString(receipt.message, 500)) return null;
  if (typeof receipt.paymentStatus !== 'string' || typeof receipt.paidAt !== 'string') return null;

  return {
    state: 'found',
    channelHandle: receipt.channelHandle,
    channelDisplayName: receipt.channelDisplayName,
    grossAmountPaise: receipt.grossAmountPaise,
    refundedAmountPaise: receipt.refundedAmountPaise,
    netAmountPaise: receipt.netAmountPaise,
    currency: 'INR',
    donorDisplayName: receipt.donorDisplayName,
    message: receipt.message,
    paymentStatus: receipt.paymentStatus,
    paidAt: receipt.paidAt,
  };
}
