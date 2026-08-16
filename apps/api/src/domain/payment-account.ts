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
  // Records that the owner/admin explicitly skipped the onboarding payout
  // step, so a returning creator who skipped isn't sent back to it forever
  // — see migration 0079_v1_l03_payout_onboarding_gate.sql. Idempotent:
  // repeated calls keep the first skip time.
  skipOnboarding(userId: string, channelId: string): Promise<string>;
}
