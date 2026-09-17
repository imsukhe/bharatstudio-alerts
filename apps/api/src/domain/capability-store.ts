// CTL phase 1: the capability control plane's ONLY consumer-facing
// surface (packages/db/migrations/0149_v1_ctl_capability_control_plane.sql).
//
// CTL-03: this type IS the resolved blob -- one jsonb object mapping
// every registered capability_key to its resolved boolean, one
// `generation` and one `resolved_at`, for the WHOLE channel in one
// read. There is no per-capability type anywhere in this file and no
// method that takes a capability key -- that shape does not exist on
// this store because it must not exist: CTL-03 requires the resolved
// blob be read once per channel, never once per flag, and the absence
// of a narrower method here is what keeps that true on the API side,
// matching the database side's own revoked-direct-table-access
// enforcement (see the migration's CTL-03 section).
//
// CTL-01/CTL-02/CTL-14/CTL-15's own machinery (the registry table
// itself, the resolution order, the durable-record guard, the
// retention-shape guard) has no representation here at all -- this
// store is a pure read over app_private.get_channel_capabilities,
// which already resolved every one of those concerns server-side.
export type ResolvedCapabilities = {
  schemaVersion: 'v1';
  generation: number;
  resolvedAt: string;
  capabilities: Record<string, boolean>;
};

export interface CapabilityStore {
  // Returns null for BOTH "channel not found" and "caller is not a
  // member of this channel" -- the same posture
  // domain/insights-store.ts's getRevenueKpis already takes (mirrored
  // from app_private.get_channel_capabilities' own has_channel_role
  // guard, migration 0149), so this endpoint cannot be used to
  // enumerate channel membership from the distinction between the two.
  getResolvedCapabilities(userId: string, channelId: string): Promise<ResolvedCapabilities | null>;
}
