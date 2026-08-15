export type PublicPaymentStatus = {
  orderId: string;
  status: 'provider_pending' | 'provider_created' | 'paid' | 'expired' | 'failed';
  amountPaise: number;
  currency: 'INR';
  updatedAt: string;
};

export interface PublicPaymentStatusRepository {
  findByOrderId(orderId: string): Promise<PublicPaymentStatus | null>;
}
