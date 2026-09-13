// Platform-staff review surface for Studio creator-pack stickers left
// open by migration 0119 (see 0119's header and packages/db/migrations/
// 0122_v1_l22c_staff_creator_pack_review.sql, which adds the SQL
// primitives this store wraps). Gated by the SAME platform-staff check
// (app_private.is_platform_admin(), reused as-is — no parallel staff
// concept) as the existing admin DLQ/entitlement/ingest-failure surfaces
// in apps/api/src/routes/admin.ts, at both the route layer
// (requirePlatformAdmin) and again inside every SQL function in 0122 —
// defense in depth, matching 0073's own admin_replay_delivery et al.
//
// PII boundary: a creator-pack sticker (public.creator_sticker_packs) has
// no supporter/tipper/viewer column at all — display_name/category
// describe the sticker, not a person. This store's read shapes are a
// direct projection of that table plus reviewer/decision/reason from the
// new staff_creator_pack_review_audit table; neither ever joins to
// payment_order_intents or channel_creator_pack_selections, so there is
// no viewer PII to leak by construction (see the 0122 migration header
// and packages/db/tests/l22c_staff_creator_pack_review.sql's exact-key-set
// assertion on the review-detail shape).
export type PendingCreatorPackEntry = {
  id: string;
  channelId: string;
  displayName: string;
  category: string;
  byteSize: number;
  creatorAttested: boolean;
  createdAt: string;
};

export type CreatorPackReviewDetail = {
  id: string;
  channelId: string;
  displayName: string;
  category: string;
  // Base64-encoded sticker asset (application/json Lottie source, same
  // 2,000,000-byte cap as 0119) — this is what a reviewer inspects.
  assetBase64: string;
  mimeType: string;
  byteSize: number;
  creatorAttested: boolean;
  status: string;
  createdAt: string;
};

export type CreatorPackReviewDecision = {
  id: string;
  status: string;
  decision: 'approved' | 'rejected';
  reviewerId: string;
  reviewedAt: string;
};

export type CreatorPackReviewAuditEntry = {
  id: string;
  reviewerId: string;
  decision: 'approved' | 'rejected';
  reason: string | null;
  reviewedAt: string;
};

// No isPlatformAdmin method here — the route layer gates every method
// below with the SAME `adminAuth` pre-handler (built from the existing
// AdminStore.isPlatformAdmin) the DLQ/entitlement/ingest-failure routes
// already use, per admin.ts's own comment on why the ingest-failure
// routes reuse that one gate rather than duplicating it per-store.
export interface StaffCreatorPackReviewStore {
  listPendingCreatorPacks(userId: string, limit: number): Promise<PendingCreatorPackEntry[]>;
  // Returns null when the id does not exist — the route maps that to 404,
  // never a 5xx.
  getCreatorPackForReview(userId: string, packStickerId: string): Promise<CreatorPackReviewDetail | null>;
  // Approving/rejecting an id that is not currently pending_review (never
  // existed, or was already decided) is a legitimate non-exceptional
  // outcome — returns null, mapped to 404 by the route, matching
  // replayDlqDelivery/discardDlqDelivery's own contract in domain/admin.ts.
  // `reason` is required by the route schema whenever `approved` is
  // false; the store still forwards it to the SQL function, which is the
  // final enforcement point.
  reviewCreatorPack(userId: string, packStickerId: string, approved: boolean, reason: string | null): Promise<CreatorPackReviewDecision | null>;
  listReviewAudit(userId: string, packStickerId: string): Promise<CreatorPackReviewAuditEntry[]>;
}
