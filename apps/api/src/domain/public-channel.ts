export type PublicChannel = {
  channelId: string;
  handle: string;
  displayName: string;
  acceptingTips: boolean;
  minimumTipPaise: number;
  publicConfigVersion: number;
};

// Deliberately narrower than PublicChannel: no channelId/minimumTipPaise/
// publicConfigVersion on an unauthenticated cross-channel listing, and no
// avatar or billing tier — neither field exists anywhere in this codebase
// (avatar previously only came from the excluded YouTube integration; tier
// would leak financial-adjacent state for no product reason). See
// packages/db/migrations/0072_v1_l03_featured_creator_listing.sql.
export type FeaturedChannel = {
  handle: string;
  displayName: string;
  acceptingTips: boolean;
  locale: string;
};

export interface PublicChannelRepository {
  findByHandle(handle: string): Promise<PublicChannel | null>;
  listFeatured(limit: number): Promise<FeaturedChannel[]>;
  /**
   * Resolves a handle that used to belong to a channel (see
   * packages/db/migrations/0087_v1_l03_channel_handle_reservation.sql's
   * channel_handle_history — a released handle is reserved forever, never
   * reassigned) to that channel's CURRENT public projection. A handle can
   * appear in the history table at most once ever, and it always maps
   * straight to the owning channel_id — so this resolves an arbitrarily
   * long rename chain (A->B->C) in one lookup, not a walk. Returns null
   * both when the handle was never released AND when it never existed at
   * all; callers must not use this to distinguish those two cases beyond
   * what the public tip page already reveals (see routes/public.ts).
   *
   * Optional: 0087 revokes all access to channel_handle_history from the
   * app role by design (a write-only reservation ledger consulted only
   * from inside change_channel_handle). Reading it publicly needs a new
   * security-definer resolver function granted via a companion migration
   * that is NOT owned by this lane (migrations are out of this ticket's
   * boundary) — until that ships, implementations of this method fail
   * closed to null. Optional also keeps every existing fake repository in
   * apps/api/test/app.test.ts (which implements only the two required
   * methods) compiling unchanged.
   */
  resolveReleasedHandle?(handle: string): Promise<PublicChannel | null>;
}
