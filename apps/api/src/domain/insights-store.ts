// OPS-08 (activation instrumentation) and the derivable half of OPS-11
// (revenue KPIs). Both are pure derived reads (§19.6) -- see
// packages/db/migrations/0133_v1_ops08_ops11_activation_and_revenue_kpis.sql
// for the full derivation and bharatstudio-requirements/reviews/2026-09-16-
// ops-activation-and-revenue-instrumentation.md for the scope decision.
//
// Neither type below is ever passed to ApiMetrics/renderPrometheus() --
// revenue numbers and activation state are durable, creator-reachable
// records (§12.6), never an ops metric (Opus's decision, §31 §12.6/§12.7
// reasoning in the review record).

export type ActivationState = {
  schemaVersion: 'v1';
  payoutConnected: boolean;
  payoutConnectedAt: string | null;
  overlayConnected: boolean;
  overlayConnectedAt: string | null;
  firstAlertFired: boolean;
  firstAlertFiredAt: string | null;
};

export type RevenueKpis = {
  schemaVersion: 'v1';
  windowStart: string | null;
  windowEnd: string | null;
  averageNetTipPaise: string;
  netTipCount: string;
  totalNetTipPaise: string;
  supporterCount: string;
  repeatSupporterCount: string;
  repeatSupporterRate: string;
  challengeRevenuePaise: string;
  voteRevenuePaise: string;
};

export interface InsightsStore {
  // Any active channel member may read this -- it carries no amount
  // (app_private.get_creator_activation_state gates on can_access_channel,
  // the same guard as get_companion_state).
  getActivationState(userId: string, channelId: string): Promise<ActivationState | null>;
  // Owner/admin only, per 00_LAUNCH_SCOPE_AUTHORITY.md's role-scoped
  // financial-visibility rule, enforced inside
  // app_private.get_channel_revenue_kpis (has_channel_role) -- a caller
  // without that role gets null here, never a thrown/403 distinction the
  // client could use to enumerate membership, matching PaymentLedgerStore's
  // own posture.
  getRevenueKpis(userId: string, channelId: string, windowStart: string | null, windowEnd: string | null): Promise<RevenueKpis | null>;
}
