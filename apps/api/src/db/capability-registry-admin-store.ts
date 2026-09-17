import type { JSONValue, Sql, TransactionSql } from 'postgres';
import {
  CapabilityRegistryAdminError,
  type CapabilityKind,
  type CapabilityRegistryAdminStore,
  type CapabilityRegistryEntry,
  type SetCapabilityRegistryEntryInput,
} from '../domain/capability-registry-admin.js';

// CTL registry spec alignment (migration 0153). Same session-scoped-
// transaction pattern as apps/api/src/db/capability-change-management-store.ts:
// set_config('app.user_id', ...) inside the transaction so
// app_private.is_platform_admin() and app_private.current_user_id() see
// the real caller. Writes take the MAIN pool, never derivedReadSql --
// same reasoning capability-change-management-store.ts already documents
// for a platform-staff governance write surface.
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

type EntryRow = {
  capability_key: string;
  capacity_class: string;
  description: string;
  kill_switch: boolean;
  rollout_percentage: number;
  min_tier: string | null;
  kind: CapabilityKind | null;
  limits: Record<string, unknown>;
  beta: boolean;
  marketing_visible: boolean;
  marketing_label: string | null;
  marketing_blurb: string | null;
  version: number;
  updated_at: Date;
  created_at?: Date;
  updated_by?: string | null;
};

function fromRow(row: EntryRow): CapabilityRegistryEntry {
  return {
    schemaVersion: 'v1',
    capabilityKey: row.capability_key,
    capacityClass: row.capacity_class,
    description: row.description,
    killSwitch: row.kill_switch,
    rolloutPercentage: row.rollout_percentage,
    minTier: row.min_tier,
    kind: row.kind,
    limits: row.limits ?? {},
    beta: row.beta,
    marketingVisible: row.marketing_visible,
    marketingLabel: row.marketing_label,
    marketingBlurb: row.marketing_blurb,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
    ...(row.created_at ? { createdAt: row.created_at.toISOString() } : {}),
    ...(row.updated_by !== undefined ? { updatedBy: row.updated_by } : {}),
  };
}

export function createSqlCapabilityRegistryAdminStore(sql: Sql): CapabilityRegistryAdminStore {
  return {
    async getEntry(userId, capabilityKey): Promise<CapabilityRegistryEntry | null> {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<EntryRow[]>`
        select capability_key, capacity_class, description, kill_switch, rollout_percentage, min_tier,
               kind, limits, beta, marketing_visible, marketing_label, marketing_blurb,
               version, created_at, updated_at, updated_by
          from app_private.staff_get_capability_registry_entry(${capabilityKey})
      `);
      return rows[0] ? fromRow(rows[0]) : null;
    },
    async listEntries(userId): Promise<CapabilityRegistryEntry[]> {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<EntryRow[]>`
        select capability_key, capacity_class, description, kill_switch, rollout_percentage, min_tier,
               kind, limits, beta, marketing_visible, marketing_label, marketing_blurb,
               version, created_at, updated_at, updated_by
          from app_private.staff_list_capability_registry_entries()
      `);
      return rows.map(fromRow);
    },
    async setEntry(userId, input): Promise<CapabilityRegistryEntry> {
      try {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<EntryRow[]>`
          select capability_key, capacity_class, description, kill_switch, rollout_percentage, min_tier,
                 kind, limits, beta, marketing_visible, marketing_label, marketing_blurb, version, updated_at
            from app_private.staff_set_capability_registry_entry(
              ${input.capabilityKey}, ${input.capacityClass}, ${input.description}, ${input.killSwitch},
              ${input.rolloutPercentage}, ${input.minTier}, ${input.kind}, ${sql.json(input.limits as JSONValue)},
              ${input.beta}, ${input.marketingVisible}, ${input.marketingLabel}, ${input.marketingBlurb}
            )
        `);
        const row = rows[0];
        if (!row) throw new CapabilityRegistryAdminError('invalid_input', 'set returned no row');
        return fromRow(row);
      } catch (error) {
        if (hasSqlstate(error, '23514')) throw new CapabilityRegistryAdminError('invalid_input', errorMessage(error));
        // Migration 0155, Job 3: changing an EXISTING capability through
        // this single-admin entry point is rejected (42501) -- it must
        // go through the two-person capability_change_requests workflow
        // instead. Distinct from the plain admin-gate 42501 the pre-
        // handler already intercepts before the store is ever called.
        if (hasSqlstate(error, '42501') && errorMessage(error).includes('must go through the two-person capability_change_requests workflow')) {
          throw new CapabilityRegistryAdminError('governance_required', errorMessage(error));
        }
        throw error;
      }
    },
  };
}
