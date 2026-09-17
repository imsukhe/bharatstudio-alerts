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

export type CapabilityChangeKind = 'update' | 'kill' | 'revert';
export type CapabilityChangeStatus = 'pending_approval' | 'approved' | 'applied' | 'rejected';
export type CapabilityApprovalKind = 'staff' | 'owner';

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
  // CTL-07 rule 3: single-admin, immediate.
  killCapability(userId: string, capabilityKey: string, reason: string | null): Promise<CapabilityChangeRequest>;
  // CTL-08: one action, immediate, append-only.
  revertCapability(userId: string, capabilityKey: string, reason: string | null): Promise<CapabilityChangeRequest>;
}
