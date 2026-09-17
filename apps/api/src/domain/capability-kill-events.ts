// Migration 0155, Job 2: §20.6.1's emergency global_kill path in full --
// a single-actor fire, a hard 24-hour expiry with read-time auto-revert,
// a mandatory-but-optional-timing second-admin ratification, a two-
// person-approved bounded extension, and a mandatory post-incident
// review that blocks the same actor's next kill until filed. See
// packages/db/migrations/0155_v1_ctl_emergency_kill_and_owner.sql's own
// Job 2 header for the full row-by-row mapping to §20.6.1's table,
// including what is deliberately NOT built here (creator notification,
// billing exemption -- neither mechanism exists anywhere in this schema
// yet).
//
// Distinct from routes/capability-change-management.ts's existing
// staff_kill_capability_now (migration 0152) -- that remains the
// ordinary, no-expiry, no-ratification per-capability kill path,
// untouched by this migration. This file is the FULLER §20.6.1
// subsystem, its own tables, its own functions.
//
// Platform-staff only (app_private.is_platform_admin()) -- same gate
// every other file in this directory uses.

export type CapabilityKillEvent = {
  schemaVersion: 'v1';
  id: string;
  capabilityKey: string;
  firedBy: string;
  firedAt: string;
  reason: string;
  // Caller-supplied impact counts (the admin panel's own impact-preview
  // feature, §20.6, is a separate, out-of-scope UI concern -- this
  // migration does not compute them live). See the migration's own
  // header for why.
  affectedChannelCount: number;
  liveChannelCount: number;
  // The CURRENT effective expiry -- base fire time + 24h, or a later
  // approved extension's stated value, whichever is later.
  expiresAt: string;
  ratifiedBy: string | null;
  ratifiedAt: string | null;
  // Read-time derived: not ratified AND now >= firedAt + 4 hours.
  escalatedToOwner: boolean;
  // Read-time derived: now >= the current effective expiresAt. A read
  // through this store lazily applies the actual registry restore
  // BEFORE this flag is computed -- so reverted=true always means the
  // restore has already happened, not merely that it is due.
  reverted: boolean;
  reviewed: boolean;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewText: string | null;
};

export type FireGlobalKillInput = {
  capabilityKey: string;
  reason: string;
  affectedChannelCount: number;
  liveChannelCount: number;
};

export type ProposeKillExtensionInput = {
  killEventId: string;
  newExpiresAt: string;
  reason: string;
};

export type KillExtensionRequest = {
  id: string;
  killEventId: string;
  requestedBy: string;
  requestedAt: string;
  newExpiresAt: string;
  reason: string;
};

// A fixed set of business-rule outcomes the SQL layer can raise:
// 22023 (a missing reason, a non-existent capability/kill event/
// extension request, an extension that does not move forward or
// applies to an already-expired kill), 23514 (an extension exceeding
// its own 24-hour-from-request cap, or a malformed fire), 42501 (the
// firer attempting to ratify their own kill, or the proposer of an
// extension attempting to also approve it), 23505 (a duplicate
// ratification, review, or extension approval), 55000 (a kill blocked
// by a previous unreviewed kill from the same actor).
export type CapabilityKillEventErrorReason =
  | 'capability_not_found'
  | 'kill_event_not_found'
  | 'extension_request_not_found'
  | 'invalid_input'
  | 'self_action_forbidden'
  | 'duplicate_action'
  | 'blocked_on_missing_review';

export class CapabilityKillEventError extends Error {
  readonly reason: CapabilityKillEventErrorReason;
  constructor(reason: CapabilityKillEventErrorReason, message: string) {
    super(message);
    this.name = 'CapabilityKillEventError';
    this.reason = reason;
  }
}

export interface CapabilityKillEventStore {
  fireKill(userId: string, input: FireGlobalKillInput): Promise<CapabilityKillEvent>;
  ratifyKill(userId: string, killEventId: string): Promise<CapabilityKillEvent>;
  proposeExtension(userId: string, input: ProposeKillExtensionInput): Promise<KillExtensionRequest>;
  approveExtension(userId: string, extensionRequestId: string): Promise<CapabilityKillEvent>;
  fileReview(userId: string, killEventId: string, reviewText: string): Promise<CapabilityKillEvent>;
  // Returns null when the id does not exist -- the route maps that to 404.
  getKillEvent(userId: string, killEventId: string): Promise<CapabilityKillEvent | null>;
  listKillEvents(userId: string, capabilityKey: string | null, limit: number): Promise<CapabilityKillEvent[]>;
}
