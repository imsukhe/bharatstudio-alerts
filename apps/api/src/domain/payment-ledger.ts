// A creator-facing read of the payment ledger — 00_LAUNCH_SCOPE_AUTHORITY.md
// already grants owner/admin "view financial amounts and raw payment/refund
// records"; this is the first surface to actually use that grant. Deliberately
// a plain data list, not a tax/compliance report — see the migration this
// reads from (0071) for why that distinction matters.
export type PaymentLedgerEntry = {
  paymentId: string;
  providerPaymentId: string;
  grossAmountPaise: number;
  currency: 'INR';
  status: 'created' | 'pending' | 'captured' | 'failed' | 'refunded' | 'partially_refunded';
  createdAt: string;
  refundTotalPaise: number;
  latestRefundStatus: 'requested' | 'processed' | 'failed' | 'reversed' | null;
};

export type PaymentLedgerPage = {
  schemaVersion: 'v1';
  items: PaymentLedgerEntry[];
  nextCursor: string | null;
};

export interface PaymentLedgerStore {
  listPayments(userId: string, channelId: string, cursor: string | undefined, pageSize: number): Promise<PaymentLedgerPage>;
}
