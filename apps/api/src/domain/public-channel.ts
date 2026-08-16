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
}
