// ADM-07: a durable admin registry, and ONE admin identity (migration
// 0156). public.app_users.is_platform_admin (migration 0073) already
// backs every platform-staff function's authorisation check
// (app_private.is_platform_admin(), unchanged by 0156) -- what 0073
// never built was a write path. This file backs the ONE write path
// migration 0156 adds, app_private.staff_set_platform_admin: never
// self-conferred (the acting admin cannot target themselves, in either
// direction -- this is also what makes a legitimate revocation chain
// unable to ever empty the registry, see the migration's own header),
// always requires an existing admin to act, always requires a reason,
// always audited in public.platform_admin_audit.
//
// The FIRST admin in any deployment cannot come from this path (there
// is no admin yet to act) -- it is set by direct database access, the
// same access level required to run the migration itself. See migration
// 0156_v1_adm_durable_admin_registry.sql's own bootstrap note.
//
// Platform-staff only (app_private.is_platform_admin()) -- same gate
// domain/platform-owner.ts and every other admin surface in this
// codebase already uses.

export type SetPlatformAdminInput = {
  targetUserId: string;
  isPlatformAdmin: boolean;
  reason: string;
};

export type PlatformAdminChange = {
  schemaVersion: 'v1';
  userId: string;
  isPlatformAdmin: boolean;
  changedBy: string;
  changedAt: string;
  reason: string;
};

export type PlatformAdminListEntry = {
  userId: string;
  displayName: string | null;
  isPlatformAdmin: boolean;
  isPlatformOwner: boolean;
  grantedBy: string | null;
  grantedAt: string | null;
  reason: string | null;
};

// The fixed set of business-rule outcomes app_private.staff_set_
// platform_admin can raise: 42501 for self-conferral or a non-admin
// caller (never reachable via legitimate app traffic for the latter,
// since requirePlatformAdmin already gates it -- self-conferral IS
// reachable, since the acting admin is always a real admin), 22023 for
// a missing reason or a non-existent target user.
export type PlatformAdminErrorReason = 'self_conferral_forbidden' | 'target_not_found' | 'invalid_input';

export class PlatformAdminError extends Error {
  readonly reason: PlatformAdminErrorReason;
  constructor(reason: PlatformAdminErrorReason, message: string) {
    super(message);
    this.name = 'PlatformAdminError';
    this.reason = reason;
  }
}

export interface PlatformAdminStore {
  setAdmin(userId: string, input: SetPlatformAdminInput): Promise<PlatformAdminChange>;
  listAdmins(userId: string): Promise<PlatformAdminListEntry[]>;
}
