// Migration 0155, Job 1: real platform-owner identity
// (bharatstudio-requirements/reviews/2026-09-17-platform-owner-identity-
// decision.md). "One owner for now, expandable later" -- carried by
// app_users.is_platform_owner plus a partial unique index admitting at
// most one true row, never a singleton table or a hardcoded id.
//
// The single write path is app_private.staff_set_platform_owner: never
// self-conferred (the acting admin cannot target themselves), always
// requires is_platform_admin(), always audited in
// public.platform_owner_audit. This file backs that ONE function --
// there is no separate "read who the owner is" surface beyond it,
// because the owner identity itself is not otherwise exposed anywhere
// today (app_private.is_platform_owner() is consulted server-side by
// app_private.staff_approve_capability_change, migration 0155, not read
// through this file).
//
// Platform-staff only (app_private.is_platform_admin()) -- same gate
// domain/capability-change-management.ts and admin.ts already use.

export type SetPlatformOwnerInput = {
  targetUserId: string;
  isPlatformOwner: boolean;
  reason: string;
};

export type PlatformOwnerChange = {
  schemaVersion: 'v1';
  userId: string;
  isPlatformOwner: boolean;
  changedBy: string;
  changedAt: string;
  reason: string;
};

// A fixed, small set of business-rule outcomes app_private.staff_set_
// platform_owner can raise: 42501 for self-conferral or a non-admin
// caller (never reachable via legitimate app traffic for the latter,
// since requirePlatformAdmin already gates it -- self-conferral IS
// reachable, since the acting admin is always a real admin), 22023 for
// a missing reason or a non-existent target user, 23505 for a promotion
// that would violate the singleton index (a second true row).
export type PlatformOwnerErrorReason = 'self_conferral_forbidden' | 'target_not_found' | 'invalid_input' | 'singleton_violation';

export class PlatformOwnerError extends Error {
  readonly reason: PlatformOwnerErrorReason;
  constructor(reason: PlatformOwnerErrorReason, message: string) {
    super(message);
    this.name = 'PlatformOwnerError';
    this.reason = reason;
  }
}

export interface PlatformOwnerStore {
  setOwner(userId: string, input: SetPlatformOwnerInput): Promise<PlatformOwnerChange>;
}
