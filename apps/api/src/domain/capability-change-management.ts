// CTL phase 2, Lane A (migration 0152): change management over the
// phase-1 capability control plane (migration 0149, untouched).
//
// This is the governance layer in front of 0149's single write path
// (app_private.staff_upsert_capability_registry_entry) -- CTL-06 staged
// effective-time changes, CTL-07's three separate authority rules
// (two-staff, owner sign-off for paid->Free, single-admin global_kill),
// CTL-08 one-action revert, and CTL-09's structural rejection of any
// correctness dimension from this panel (proposedCapacityClass carries
// the identical closed whitelist as 0149's own capacity_class -- see
// packages/db/migrations/0152_v1_ctl_change_management.sql's header).
//
// Platform-staff only (app_private.is_platform_admin(), the SAME gate
// admin.ts's DLQ/entitlement/ingest-failure/creator-pack-review routes
// already use) -- there is no channel-scoped access check anywhere in
// this file, because capability_registry (and this governance layer
// over it) is platform-wide, never per-channel.
//
// Migration 0157 widened this workflow to carry all twelve §20.2
// registry fields (the original six plus kind/limits/beta/
// marketing_visible/marketing_label/marketing_blurb, migration 0153's
// own field set that had no governed change path at all on an existing
// capability until this migration). The six new proposed* fields use
// MERGE semantics, not full-replace: `null` on any of them means "this
// change does not touch this field" and the capability's current value
// is preserved on apply -- an ordinary six-field-only change (the six
// new fields all omitted from the request body) behaves exactly as it
// did before this migration. See packages/db/migrations/
// 0157_v1_ctl_change_management_twelve_fields.sql's own header for the
// full reasoning, including the one named limitation (a previously-set
// marketingLabel/marketingBlurb cannot be explicitly cleared back to
// null through this workflow -- omitting it preserves it, it does not
// clear it).

export type CapabilityChangeKind = 'update' | 'kill' | 'revert';
export type CapabilityChangeStatus = 'pending_approval' | 'approved' | 'applied' | 'rejected';
export type CapabilityApprovalKind = 'staff' | 'owner';
export type CapabilityChangeKindTaxonomy = 'widget' | 'module' | 'feature' | 'hub_lane' | 'lobby_mode' | 'ai_feature';

export type CapabilityChangeRequest = {
  schemaVersion: 'v1';
  id: string;
  capabilityKey: string;
  changeKind: CapabilityChangeKind;
  status: CapabilityChangeStatus;
  proposedCapacityClass: string;
  proposedDescription: string;
  proposedKillSwitch: boolean;
  proposedRolloutPercentage: number;
  proposedMinTier: string | null;
  // Migration 0157, the six §20.2 fields migration 0153 added --
  // present here (null or a value) on every row regardless of when it
  // was created; null means either "this change never touched this
  // field" (an ordinary six-field change, or any row created before
  // migration 0157 shipped) or, for a `kill` row, "a kill never touches
  // these fields at all" -- see this file's own header for the merge
  // semantics that apply on `changeKind: update`.
  proposedKind: CapabilityChangeKindTaxonomy | null;
  proposedLimits: Record<string, unknown> | null;
  proposedBeta: boolean | null;
  proposedMarketingVisible: boolean | null;
  proposedMarketingLabel: string | null;
  proposedMarketingBlurb: string | null;
  // CTL-06: may be in the future for a still-staged change.
  effectiveAt: string;
  requiresOwnerSignoff: boolean;
  staffApprovalCount: number;
  ownerApprovalCount: number;
  createdBy: string;
  createdAt: string;
  appliedAt: string | null;
  decidedAt: string | null;
  reason: string | null;
};

export type CapabilityChangeApproval = {
  id: string;
  approvalKind: CapabilityApprovalKind;
  approverId: string;
  approvedAt: string;
};

export type ProposeCapabilityChangeInput = {
  capabilityKey: string;
  capacityClass: string;
  description: string;
  killSwitch: boolean;
  rolloutPercentage: number;
  minTier: string | null;
  // CTL-06: omitted means "now" (an ordinary, unstaged change).
  effectiveAt: string | null;
  reason: string | null;
  // Migration 0157: `null`/omitted on any of these six means "this
  // change does not touch this field" -- merge semantics, see this
  // file's own header, including the one named limitation on clearing
  // marketingLabel/marketingBlurb. A real, non-null value (an explicit
  // `false` or `{}` included) is written verbatim.
  kind: CapabilityChangeKindTaxonomy | null | undefined;
  limits: Record<string, unknown> | null | undefined;
  beta: boolean | null | undefined;
  marketingVisible: boolean | null | undefined;
  marketingLabel: string | null | undefined;
  marketingBlurb: string | null | undefined;
};

// A fixed, small set of business-rule outcomes the SQL layer can raise
// (packages/db/migrations/0152_v1_ctl_change_management.sql, SQLSTATE
// 22023 in every case -- distinguished here by matching the exact
// `raise exception` message text each function uses, since 22023 alone
// does not distinguish "not found" from "not open for approval" from
// "the proposer may not approve their own change"). The store classifies
// the underlying postgres error into exactly one of these; the route
// layer maps each to its own HTTP status -- see routes/
// capability-change-management.ts.
export type CapabilityChangeErrorReason =
  | 'not_found'
  | 'capability_not_found'
  | 'not_open'
  | 'self_approval_forbidden'
  | 'owner_signoff_not_required'
  // Migration 0155, Job 1: an approval_kind='owner' call by a platform
  // admin who is not the real platform owner (app_private.is_platform_
  // owner()). Distinct from self_approval_forbidden -- this is an
  // identity failure, not a maker-checker one -- and reachable via
  // legitimate app traffic (requirePlatformAdmin only checks
  // is_platform_admin, not is_platform_owner), unlike the SQL layer's
  // defense-in-depth is_platform_admin() re-checks elsewhere in this
  // file, which the app-level gate already makes unreachable.
  | 'owner_identity_required'
  | 'no_previous_version'
  | 'duplicate_approval'
  | 'invalid_input';

export class CapabilityChangeManagementError extends Error {
  readonly reason: CapabilityChangeErrorReason;
  constructor(reason: CapabilityChangeErrorReason, message: string) {
    super(message);
    this.name = 'CapabilityChangeManagementError';
    this.reason = reason;
  }
}

export interface CapabilityChangeManagementStore {
  proposeChange(userId: string, input: ProposeCapabilityChangeInput): Promise<CapabilityChangeRequest>;
  listChanges(userId: string, status: CapabilityChangeStatus | null, limit: number): Promise<CapabilityChangeRequest[]>;
  // Returns null when the id does not exist -- the route maps that to 404.
  getChange(userId: string, changeRequestId: string): Promise<CapabilityChangeRequest | null>;
  listApprovals(userId: string, changeRequestId: string): Promise<CapabilityChangeApproval[]>;
  approveChange(userId: string, changeRequestId: string, approvalKind: CapabilityApprovalKind): Promise<CapabilityChangeRequest>;
  rejectChange(userId: string, changeRequestId: string, reason: string): Promise<CapabilityChangeRequest>;
  // CTL-08: one action, immediate, append-only.
  revertCapability(userId: string, capabilityKey: string, reason: string | null): Promise<CapabilityChangeRequest>;
}
