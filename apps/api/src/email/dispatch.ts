import type { EmailOutboxStore, EmailSender } from '../domain/email.js';

export type EmailDrainSummary = {
  claimed: number;
  sent: number;
  disabled: number;
  retried: number;
};

// Mirrors dispatchOperationalNotification's own shape: per-item isolation
// (one bad send never blocks the batch), the sender never decides retry
// scheduling itself — this loop does, by leaving a failed send as 'failed'
// for the next drain to pick back up. A recipient with no verified email
// on file is 'disabled' before any provider call is attempted, never
// silently retried forever.
export async function drainEmailOutbox(store: EmailOutboxStore, sender: EmailSender | undefined, limit: number): Promise<EmailDrainSummary> {
  const summary: EmailDrainSummary = { claimed: 0, sent: 0, disabled: 0, retried: 0 };
  const claimed = await store.claimPending(limit);
  summary.claimed = claimed.length;

  for (const email of claimed) {
    if (!email.recipientEmail || !email.recipientEmailVerified) {
      await store.complete(email.id, 'disabled', 'recipient has no verified email on file');
      summary.disabled += 1;
      continue;
    }
    if (!sender) {
      await store.complete(email.id, 'pending', 'no email provider configured');
      continue;
    }
    try {
      const outcome = await sender.send(email);
      if (outcome === 'sent') {
        await store.complete(email.id, 'sent', null);
        summary.sent += 1;
      } else {
        await store.complete(email.id, 'failed', 'provider reported a retryable failure');
        summary.retried += 1;
      }
    } catch (error) {
      await store.complete(email.id, 'failed', error instanceof Error ? error.message.slice(0, 500) : 'unknown error');
      summary.retried += 1;
    }
  }

  return summary;
}
