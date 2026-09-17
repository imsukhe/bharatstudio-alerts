import type { MarketingRevalidateResult, MarketingRevalidateWebhook } from '../domain/marketing-revalidate-webhook.js';

// CTL-11: the outbound half of "webhook revalidation" -- see
// domain/marketing-revalidate-webhook.ts for the full boundary
// reasoning (no capability data flows in; the payload here is a trigger
// signal only). A short timeout (AbortController) so a slow or hung
// marketing deployment can never hold a publish request open --
// publishing the snapshot has already succeeded in the database by the
// time this runs (see routes/capability-matrix-admin.ts), so a failed
// or slow webhook call degrades to "marketing will pick it up on its
// next scheduled rebuild" rather than "the publish failed".
const WEBHOOK_TIMEOUT_MS = 5000;

export function createFetchMarketingRevalidateWebhook(url: string | undefined, secret: string | undefined): MarketingRevalidateWebhook {
  return {
    async notify(snapshotVersion, publishedAt): Promise<MarketingRevalidateResult> {
      if (!url) {
        return { attempted: false, delivered: false };
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(secret ? { 'x-bharatstudio-webhook-secret': secret } : {}),
          },
          // Trigger signal only -- version and timestamp, never a
          // capability row, label, blurb, or tier. The marketing side
          // fetches the actual matrix itself from the public route.
          body: JSON.stringify({ schemaVersion: 'v1', snapshotVersion, publishedAt }),
          signal: controller.signal,
        });
        return { attempted: true, delivered: response.ok, statusCode: response.status };
      } catch (error) {
        return {
          attempted: true,
          delivered: false,
          error: error instanceof Error ? error.message : 'unknown webhook error',
        };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
