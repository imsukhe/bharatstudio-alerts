import assert from 'node:assert/strict';
import test from 'node:test';
import { drainEmailOutbox } from '../src/email/dispatch.js';
import { createResendEmailSender } from '../src/email/resend-sender.js';
import type { ClaimedEmail, EmailOutboxStore } from '../src/domain/email.js';

function fakeStore(claimed: ClaimedEmail[]): EmailOutboxStore & { completions: { id: string; status: string; error: string | null }[] } {
  const completions: { id: string; status: string; error: string | null }[] = [];
  return {
    completions,
    async claimPending() { return claimed; },
    async complete(id, status, error) { completions.push({ id, status, error }); },
    async enqueueDpdpExportEmail() { /* not exercised here */ },
  };
}

const verifiedEmail: ClaimedEmail = {
  id: '00000000-0000-4000-8000-000000001101', kind: 'invoice_subscription_event', recipientUserId: '00000000-0000-4000-8000-000000001001',
  recipientEmail: 'creator@example.test', recipientEmailVerified: true, channelId: '00000000-0000-4000-8000-000000001011',
  payload: { status: 'active', tier: 'creator' }, attemptCount: 0,
};

const unverifiedEmail: ClaimedEmail = {
  id: '00000000-0000-4000-8000-000000001102', kind: 'dpdp_export_delivery', recipientUserId: '00000000-0000-4000-8000-000000001002',
  recipientEmail: null, recipientEmailVerified: false, channelId: null, payload: {}, attemptCount: 0,
};

test('drainEmailOutbox marks an unverified/missing recipient disabled without ever calling the sender', async () => {
  const store = fakeStore([unverifiedEmail]);
  let senderCalled = false;
  const summary = await drainEmailOutbox(store, { async send() { senderCalled = true; return 'sent'; } }, 25);
  assert.equal(senderCalled, false);
  assert.equal(summary.disabled, 1);
  assert.deepEqual(store.completions, [{ id: unverifiedEmail.id, status: 'disabled', error: 'recipient has no verified email on file' }]);
});

test('drainEmailOutbox marks a sent email as sent and a retryable outcome as failed', async () => {
  const store = fakeStore([verifiedEmail]);
  const sentSummary = await drainEmailOutbox(store, { async send() { return 'sent'; } }, 25);
  assert.equal(sentSummary.sent, 1);
  assert.equal(store.completions[0]?.status, 'sent');

  const retryStore = fakeStore([verifiedEmail]);
  const retrySummary = await drainEmailOutbox(retryStore, { async send() { return 'retryable'; } }, 25);
  assert.equal(retrySummary.retried, 1);
  assert.equal(retryStore.completions[0]?.status, 'failed');
});

test('drainEmailOutbox never lets a sender exception escape — it completes as failed and continues the batch', async () => {
  const store = fakeStore([verifiedEmail, { ...verifiedEmail, id: '00000000-0000-4000-8000-000000001103' }]);
  let calls = 0;
  const summary = await drainEmailOutbox(store, {
    async send() {
      calls += 1;
      if (calls === 1) throw new Error('provider outage');
      return 'sent';
    },
  }, 25);
  assert.equal(calls, 2);
  assert.equal(summary.retried, 1);
  assert.equal(summary.sent, 1);
});

test('drainEmailOutbox leaves claimed rows pending (not failed) when no sender is configured, so a later drain can retry', async () => {
  const store = fakeStore([verifiedEmail]);
  const summary = await drainEmailOutbox(store, undefined, 25);
  assert.equal(summary.sent, 0);
  assert.equal(summary.retried, 0);
  assert.equal(store.completions[0]?.status, 'pending');
});

test('the Resend sender sends the operational-only rendered message and never leaks donor/tip content into the payload', async () => {
  let seenBody: Record<string, unknown> | undefined;
  const sender = createResendEmailSender('re_test_key', 'alerts@example.test', 'https://api.resend.example/emails', async (_url, init) => {
    seenBody = JSON.parse(String(init?.body));
    return new Response(null, { status: 200 });
  });
  const outcome = await sender.send(verifiedEmail);
  assert.equal(outcome, 'sent');
  assert.deepEqual(seenBody?.to, ['creator@example.test']);
  assert.equal(typeof seenBody?.subject, 'string');
  assert.equal(JSON.stringify(seenBody).includes('donor'), false);
});

test('the Resend sender reports a non-2xx response and a network failure both as retryable, never throwing', async () => {
  const failingSender = createResendEmailSender('re_test_key', 'alerts@example.test', 'https://api.resend.example/emails', async () => new Response(null, { status: 500 }));
  assert.equal(await failingSender.send(verifiedEmail), 'retryable');

  const networkErrorSender = createResendEmailSender('re_test_key', 'alerts@example.test', 'https://api.resend.example/emails', async () => { throw new Error('DNS failure'); });
  assert.equal(await networkErrorSender.send(verifiedEmail), 'retryable');
});

test('the Resend sender rejects an insecure endpoint, a missing key, and a malformed from-address at construction', () => {
  assert.throws(() => createResendEmailSender('', 'alerts@example.test'), /API key/);
  assert.throws(() => createResendEmailSender('re_test_key', 'not-an-email'), /from-address/);
  assert.throws(() => createResendEmailSender('re_test_key', 'alerts@example.test', 'http://api.resend.example/emails'), /HTTPS/);
});
