// CTL-11: "the marketing build reads the snapshot; webhook revalidation."
//
// This is the OUTBOUND half only -- the alerts API, after a successful
// publish (routes/capability-matrix-admin.ts), calls OUT to the
// marketing site's own revalidation endpoint. It is deliberately NOT an
// inbound webhook receiver on this API: "no capability data flows in" is
// this task's own hard constraint, and the cleanest way to make that
// true structurally is to never accept an inbound call at all on this
// side. The marketing repository owns receiving the call (bharatstudio-
// marketing's own app/api/revalidate route -- see that repository's own
// changes, reported in this task's return contract) and, once
// triggered, fetches the actual matrix data itself from
// GET /v1/public/capability-matrix -- the SAME public, unauthenticated
// route any other caller uses. The payload this interface sends across
// carries only a version number and a timestamp: a trigger signal, never
// a capability row, a label, a blurb, or a tier.
export type MarketingRevalidateResult = {
  // false when no webhook URL is configured at all (local/dev/test) --
  // not an error, a deliberate no-op.
  attempted: boolean;
  delivered: boolean;
  statusCode?: number;
  error?: string;
};

export interface MarketingRevalidateWebhook {
  notify(snapshotVersion: number, publishedAt: string): Promise<MarketingRevalidateResult>;
}
