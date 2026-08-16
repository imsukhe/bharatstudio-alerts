// Email delivery — "v1 scope addendum — 2026-08-16": a real provider
// integration (invoice/subscription events, DPDP export delivery,
// overlay-expiry reminder) — provider credentials remain an external gate,
// but the integration code is v1-required. See packages/db/migrations/
// 0075_v1_l02_l03_l04_email_delivery.sql for the durable-outbox design.
export type EmailKind = 'invoice_subscription_event' | 'dpdp_export_delivery' | 'overlay_expiry_reminder';

export type ClaimedEmail = {
  id: string;
  kind: EmailKind;
  recipientUserId: string;
  // Null when the recipient has no email on file yet — the sender must
  // treat this as 'disabled', never attempt a send, never retry.
  recipientEmail: string | null;
  recipientEmailVerified: boolean;
  channelId: string | null;
  payload: Record<string, unknown>;
  attemptCount: number;
};

export type EmailOutboxCompletionStatus = 'sent' | 'failed' | 'disabled' | 'pending';

export interface EmailSender {
  // 'retryable' leaves the row completed as 'failed' (attempt_count
  // incremented) for a later drain to pick up again — this interface never
  // decides retry scheduling itself, matching dispatchOperationalNotification's
  // "the caller owns durable retry scheduling" rule.
  send(message: ClaimedEmail): Promise<'sent' | 'retryable'>;
}

export interface EmailOutboxStore {
  claimPending(limit: number): Promise<ClaimedEmail[]>;
  complete(id: string, status: EmailOutboxCompletionStatus, error: string | null): Promise<void>;
  // The one client-facing trigger among the three kinds — DPDP export
  // delivery is opt-in per request, not automatic.
  enqueueDpdpExportEmail(userId: string): Promise<void>;
}
