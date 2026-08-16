import type { ClaimedEmail, EmailSender } from '../domain/email.js';

const SEND_TIMEOUT_MS = 5_000;
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

// The channel is operational/transactional-only, mirroring
// notification-dispatch-policy.ts's own content rule: no donor, tip,
// message, amount or stream-content data ever appears in these subjects —
// only the operational fact itself (billing state changed, an export is
// ready, an overlay session is expiring).
function renderMessage(email: ClaimedEmail): { subject: string; text: string } {
  switch (email.kind) {
    case 'invoice_subscription_event': {
      const status = String(email.payload.status ?? 'updated');
      const tier = String(email.payload.tier ?? '');
      return {
        subject: `Your BharatStudio ${tier ? `${tier} ` : ''}subscription is ${status}`,
        text: `Your subscription status changed to "${status}". Sign in to your dashboard to review billing details.`,
      };
    }
    case 'dpdp_export_delivery':
      return {
        subject: 'Your BharatStudio data export',
        text: 'Your requested account data export is ready. Sign in and visit Settings to download it.',
      };
    case 'overlay_expiry_reminder':
      return {
        subject: 'Your BharatStudio overlay link is expiring soon',
        text: 'One of your overlay browser-source links expires within 7 days. Sign in and visit Overlay setup to rotate it before it stops working.',
      };
  }
}

// Real HTTP integration against Resend's send API, mirroring
// createSarvamTtsProvider's pattern exactly: constructed only when a
// credential is present, an injectable fetcher for testing, a bounded
// timeout, https-only. Credentials remain an external gate (RESEND_API_KEY
// is never provisioned by this codebase); this is the integration code the
// v1 scope addendum requires ready to activate once they exist.
export function createResendEmailSender(
  apiKey: string,
  fromAddress: string,
  endpoint = 'https://api.resend.com/emails',
  fetcher: FetchLike = fetch,
): EmailSender {
  if (!apiKey.trim()) throw new Error('Resend API key is required');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromAddress)) throw new Error('Resend from-address is invalid');
  const parsedEndpoint = new URL(endpoint);
  if (parsedEndpoint.protocol !== 'https:') throw new Error('Resend endpoint must use HTTPS');
  return {
    // The caller (the drain loop) is responsible for never invoking this
    // with a recipient that has no verified email on file — that is a
    // 'disabled' outcome, decided before any provider call is made, not a
    // send failure this function should classify.
    async send(email) {
      const { subject, text } = renderMessage(email);
      try {
        const response = await fetcher(parsedEndpoint.toString(), {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ from: fromAddress, to: [email.recipientEmail], subject, text }),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
        return response.ok ? 'sent' : 'retryable';
      } catch {
        return 'retryable';
      }
    },
  };
}
