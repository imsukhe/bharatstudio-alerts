import type { Sql, TransactionSql } from 'postgres';
import {
  CapabilityChangeManagementError,
  type CapabilityApprovalKind,
  type CapabilityChangeApproval,
  type CapabilityChangeManagementStore,
  type CapabilityChangeRequest,
  type CapabilityChangeStatus,
  type ProposeCapabilityChangeInput,
} from '../domain/capability-change-management.js';

// CTL phase 2, Lane A (migration 0152). Same session-scoped-transaction
// pattern as apps/api/src/db/admin-store.ts and apps/api/src/db/
// staff-creator-pack-review-store.ts: set_config('app.user_id', ...)
// inside the transaction so app_private.is_platform_admin() and
// app_private.current_user_id() see the real caller, never a shared
// service identity. Writes -- takes the MAIN pool, never derivedReadSql,
// same reasoning apps/api/src/index.ts already documents for every other
// write-carrying store.
async function inUserTransaction<T>(sql: Sql, userId: string, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return callback(tx);
  });
  return result as T;
}

function hasSqlstate(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === code;
}

function errorMessage(error: unknown): string {
  return typeof error === 'object' && error !== null && 'message' in error ? String((error as { message: unknown }).message) : '';
}

// Classifies a 22023 ("invalid input") raised by
// packages/db/migrations/0152_v1_ctl_change_management.sql's functions
// into exactly one CapabilityChangeErrorReason, by matching the literal
// `raise exception` message text each function uses. 23505
// (unique_violation, the same-approver-twice case) is classified
// separately by SQLSTATE alone, ahead of this. See domain/
// capability-change-management.ts's own comment on why 22023 alone is
// not enough to distinguish these outcomes.
function classify(error: unknown): CapabilityChangeManagementError {
  const message = errorMessage(error);
  if (message.includes('not found')) return new CapabilityChangeManagementError('not_found', message);
  if (message.includes('does not exist')) return new CapabilityChangeManagementError('capability_not_found', message);
  if (message.includes('not open for')) return new CapabilityChangeManagementError('not_open', message);
  if (message.includes('may not also approve')) return new CapabilityChangeManagementError('self_approval_forbidden', message);
  if (message.includes('does not require owner sign-off')) return new CapabilityChangeManagementError('owner_signoff_not_required', message);
  if (message.includes('no previous version') || message.includes('no audit record found')) {
    return new CapabilityChangeManagementError('no_previous_version', message);
  }
  return new CapabilityChangeManagementError('invalid_input', message);
}

type ChangeRow = {
  id: string;
  capability_key: string;
  change_kind: 'update' | 'kill' | 'revert';
  status: CapabilityChangeStatus;
  proposed_capacity_class: string;
  proposed_description: string;
  proposed_kill_switch: boolean;
  proposed_rollout_percentage: number;
  proposed_min_tier: string | null;
  effective_at: Date;
  requires_owner_signoff: boolean;
  staff_approval_count: number;
  owner_approval_count: number;
  created_by: string;
  created_at: Date;
  applied_at: Date | null;
  decided_at: Date | null;
  reason: string | null;
};

function fromRow(row: ChangeRow): CapabilityChangeRequest {
  return {
    schemaVersion: 'v1',
    id: row.id,
    capabilityKey: row.capability_key,
    changeKind: row.change_kind,
    status: row.status,
    proposedCapacityClass: row.proposed_capacity_class,
    proposedDescription: row.proposed_description,
    proposedKillSwitch: row.proposed_kill_switch,
    proposedRolloutPercentage: row.proposed_rollout_percentage,
    proposedMinTier: row.proposed_min_tier,
    effectiveAt: row.effective_at.toISOString(),
    requiresOwnerSignoff: row.requires_owner_signoff,
    staffApprovalCount: row.staff_approval_count,
    ownerApprovalCount: row.owner_approval_count,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    appliedAt: row.applied_at ? row.applied_at.toISOString() : null,
    decidedAt: row.decided_at ? row.decided_at.toISOString() : null,
    reason: row.reason,
  };
}

export function createSqlCapabilityChangeManagementStore(sql: Sql): CapabilityChangeManagementStore {
  return {
    async proposeChange(userId, input): Promise<CapabilityChangeRequest> {
      try {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<ChangeRow[]>`
          select id, capability_key, change_kind, status, proposed_capacity_class, proposed_description,
          proposed_kill_switch, proposed_rollout_percentage, proposed_min_tier, effective_at,
          requires_owner_signoff, staff_approval_count, owner_approval_count, created_by, created_at,
          applied_at, decided_at, reason
            from app_private.staff_propose_capability_change(
              ${input.capabilityKey}, ${input.capacityClass}, ${input.description}, ${input.killSwitch},
              ${input.rolloutPercentage}, ${input.minTier}, ${input.effectiveAt}, ${input.reason}
            )
        `);
        const row = rows[0];
        if (!row) throw new CapabilityChangeManagementError('invalid_input', 'propose returned no row');
        return fromRow(row);
      } catch (error) {
        if (hasSqlstate(error, '22023')) throw classify(error);
        throw error;
      }
    },
    async listChanges(userId, status, limit): Promise<CapabilityChangeRequest[]> {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<ChangeRow[]>`
        select id, capability_key, change_kind, status, proposed_capacity_class, proposed_description,
          proposed_kill_switch, proposed_rollout_percentage, proposed_min_tier, effective_at,
          requires_owner_signoff, staff_approval_count, owner_approval_count, created_by, created_at,
          applied_at, decided_at, reason
          from app_private.staff_list_capability_changes(${status}, ${limit})
      `);
      return rows.map(fromRow);
    },
    async getChange(userId, changeRequestId): Promise<CapabilityChangeRequest | null> {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<ChangeRow[]>`
        select id, capability_key, change_kind, status, proposed_capacity_class, proposed_description,
          proposed_kill_switch, proposed_rollout_percentage, proposed_min_tier, effective_at,
          requires_owner_signoff, staff_approval_count, owner_approval_count, created_by, created_at,
          applied_at, decided_at, reason
          from app_private.staff_get_capability_change(${changeRequestId}::uuid)
      `);
      return rows[0] ? fromRow(rows[0]) : null;
    },
    async listApprovals(userId, changeRequestId): Promise<CapabilityChangeApproval[]> {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<{
        id: string; approval_kind: CapabilityApprovalKind; approver_id: string; approved_at: Date;
      }[]>`
        select id, approval_kind, approver_id, approved_at
          from app_private.staff_list_capability_change_approvals(${changeRequestId}::uuid)
      `);
      return rows.map((row) => ({
        id: row.id, approvalKind: row.approval_kind, approverId: row.approver_id, approvedAt: row.approved_at.toISOString(),
      }));
    },
    async approveChange(userId, changeRequestId, approvalKind): Promise<CapabilityChangeRequest> {
      try {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<ChangeRow[]>`
          select id, capability_key, change_kind, status, proposed_capacity_class, proposed_description,
          proposed_kill_switch, proposed_rollout_percentage, proposed_min_tier, effective_at,
          requires_owner_signoff, staff_approval_count, owner_approval_count, created_by, created_at,
          applied_at, decided_at, reason
            from app_private.staff_approve_capability_change(${changeRequestId}::uuid, ${approvalKind})
        `);
        const row = rows[0];
        if (!row) throw new CapabilityChangeManagementError('not_found', 'approve returned no row');
        return fromRow(row);
      } catch (error) {
        if (hasSqlstate(error, '23505')) throw new CapabilityChangeManagementError('duplicate_approval', errorMessage(error));
        if (hasSqlstate(error, '22023')) throw classify(error);
        throw error;
      }
    },
    async rejectChange(userId, changeRequestId, reason): Promise<CapabilityChangeRequest> {
      try {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<ChangeRow[]>`
          select id, capability_key, change_kind, status, proposed_capacity_class, proposed_description,
          proposed_kill_switch, proposed_rollout_percentage, proposed_min_tier, effective_at,
          requires_owner_signoff, staff_approval_count, owner_approval_count, created_by, created_at,
          applied_at, decided_at, reason
            from app_private.staff_reject_capability_change(${changeRequestId}::uuid, ${reason})
        `);
        const row = rows[0];
        if (!row) throw new CapabilityChangeManagementError('not_found', 'reject returned no row');
        return fromRow(row);
      } catch (error) {
        if (hasSqlstate(error, '22023')) throw classify(error);
        throw error;
      }
    },
    async killCapability(userId, capabilityKey, reason): Promise<CapabilityChangeRequest> {
      try {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<ChangeRow[]>`
          select id, capability_key, change_kind, status, proposed_capacity_class, proposed_description,
          proposed_kill_switch, proposed_rollout_percentage, proposed_min_tier, effective_at,
          requires_owner_signoff, staff_approval_count, owner_approval_count, created_by, created_at,
          applied_at, decided_at, reason
            from app_private.staff_kill_capability_now(${capabilityKey}, ${reason})
        `);
        const row = rows[0];
        if (!row) throw new CapabilityChangeManagementError('capability_not_found', 'kill returned no row');
        return fromRow(row);
      } catch (error) {
        if (hasSqlstate(error, '22023')) throw classify(error);
        throw error;
      }
    },
    async revertCapability(userId, capabilityKey, reason): Promise<CapabilityChangeRequest> {
      try {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<ChangeRow[]>`
          select id, capability_key, change_kind, status, proposed_capacity_class, proposed_description,
          proposed_kill_switch, proposed_rollout_percentage, proposed_min_tier, effective_at,
          requires_owner_signoff, staff_approval_count, owner_approval_count, created_by, created_at,
          applied_at, decided_at, reason
            from app_private.staff_revert_capability_registry_entry(${capabilityKey}, ${reason})
        `);
        const row = rows[0];
        if (!row) throw new CapabilityChangeManagementError('capability_not_found', 'revert returned no row');
        return fromRow(row);
      } catch (error) {
        if (hasSqlstate(error, '22023')) throw classify(error);
        throw error;
      }
    },
  };
}
