export type PaymentAccount = {
  schemaVersion: 'v1';
  accountId: string;
  channelId: string;
  provider: 'razorpay';
  environment: 'test' | 'live';
  connectedAccountRef: string;
  status: 'pending' | 'active' | 'revoked';
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
};

export interface PaymentAccountStore {
  list(userId: string, channelId: string): Promise<PaymentAccount[]>;
  register(userId: string, channelId: string, environment: 'test' | 'live', connectedAccountRef: string): Promise<PaymentAccount>;
  revoke(userId: string, channelId: string, environment: 'test' | 'live'): Promise<boolean>;
}
