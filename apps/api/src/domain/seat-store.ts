// Domain types for channel_memberships seat management (MASTER-PLAN §3.14).
// See packages/db/migrations/0104_v1_l03_moderator_seat_enforcement.sql for
// the enforcement this store's sole write path (setMemberRole) is backed by.

export type ChannelMembershipRole = 'owner' | 'admin' | 'operator' | 'moderator' | 'viewer';

export type ChannelMembership = {
  schemaVersion: 'v1';
  channelId: string;
  userId: string;
  role: ChannelMembershipRole;
  createdAt: string;
  revokedAt: string | null;
};

export type SeatStore = {
  // Grants a channel_memberships row, or changes an existing one's role.
  // Only a transition into 'moderator' for a member who is not already an
  // active moderator is seat-limited by the channel's current tier — see
  // 0104's app_private.set_channel_membership_role for the full contract,
  // including which Postgres error codes this can reject with.
  setMemberRole(
    actingUserId: string,
    channelId: string,
    targetUserId: string,
    role: ChannelMembershipRole
  ): Promise<ChannelMembership>;
};
