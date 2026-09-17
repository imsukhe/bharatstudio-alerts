// CTL-10 (migration 0160): the public, unauthenticated capability matrix.
// GET /v1/public/capability-matrix -- see routes/public-capability-matrix.ts.
//
// This type is DELIBERATELY narrower than domain/capability-registry-admin.ts's
// CapabilityRegistryEntry: no capacityClass, limits, beta, killSwitch,
// rolloutPercentage, version, or any audit field. §20.4's own line
// ("capability id, marketing label, blurb, and the minimum tier") plus
// isMarketingSection (CTL-12 -- so the marketing build can tell a page-
// region flag from a capability entry in the one snapshot both now
// share) plus the two snapshot-identity fields every entry repeats
// (snapshotVersion, publishedAt) so a caller can tell a stale copy from
// a fresh one without a second request. This is the SAME leak-proofing
// idiom domain/public-channel.ts's FeaturedChannel already uses
// ("Deliberately narrower than PublicChannel") -- a property of the
// declared type, not something a serializer trims at the last moment.
export type PublicCapabilityMatrixEntry = {
  capabilityId: string;
  marketingLabel: string | null;
  marketingBlurb: string | null;
  minTier: string | null;
  isMarketingSection: boolean;
  snapshotVersion: number;
  publishedAt: string;
};

export interface PublicCapabilityMatrixRepository {
  // Empty array both when nothing has ever been published and when the
  // latest published snapshot happens to contain zero marketing_visible
  // rows -- the route does not distinguish these, matching
  // app_private.get_public_capability_matrix's own "no snapshot yet"
  // posture (empty result, never an error, never a different shape).
  getMatrix(): Promise<PublicCapabilityMatrixEntry[]>;
}
