import { createHash } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import type {
  MasterCanvasModule,
  MasterCanvasModuleInactiveReason,
  MasterCanvasModuleKey,
  MasterCanvasOverlayStore,
  MasterCanvasStore,
  UpsertMasterCanvasModuleResult,
} from '../domain/master-canvas-store.js';

// Same convention as apps/api/src/db/companion-entitlement-sql-store.ts's
// own inUserTransaction / apps/api/src/db/goal-store.ts's — a deliberate
// small duplication across store files rather than importing across an
// ownership boundary.
async function inUserTransaction<T>(sql: Sql, userId: string, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return callback(tx);
  });
  return result as T;
}

// Same sha256-fingerprint-of-the-bearer-token scheme every overlay read in
// this codebase uses (db/goal-overlay-store.ts, db/interaction-sql-store.ts)
// — matched against overlay_sessions.token_fingerprint inside the
// SECURITY DEFINER function. No new auth path.
function fingerprint(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

type ModuleRow = {
  module_key: MasterCanvasModuleKey;
  enabled: boolean;
  active: boolean;
  inactive_reason: MasterCanvasModuleInactiveReason | null;
  created_at: Date;
  updated_at: Date;
};

function toModule(row: ModuleRow): MasterCanvasModule {
  return {
    schemaVersion: 'v1',
    moduleKey: row.module_key,
    enabled: row.enabled,
    active: row.active,
    inactiveReason: row.inactive_reason,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function isPgErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code;
}

export function createSqlMasterCanvasStore(sql: Sql): MasterCanvasStore {
  return {
    async list(userId, channelId) {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<ModuleRow[]>`
        select module_key, enabled, active, inactive_reason, created_at, updated_at
          from app_private.list_channel_master_canvas_modules(${channelId}::uuid)
      `);
      return rows.map(toModule);
    },
    async upsert(userId, channelId, moduleKey, enabled): Promise<UpsertMasterCanvasModuleResult> {
      try {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<{ upsert_master_canvas_module: string }[]>`
          select app_private.upsert_master_canvas_module(${channelId}::uuid, ${moduleKey}, ${enabled})
        `);
        const moduleId = rows[0]?.upsert_master_canvas_module;
        if (!moduleId) return { outcome: 'invalid' };
        const listed = await inUserTransaction(sql, userId, (tx) => tx<ModuleRow[]>`
          select module_key, enabled, active, inactive_reason, created_at, updated_at
            from app_private.list_channel_master_canvas_modules(${channelId}::uuid)
           where module_key = ${moduleKey}
        `);
        const row = listed[0];
        return row ? { outcome: 'ok', module: toModule(row) } : { outcome: 'invalid' };
      } catch (error) {
        // 42501 = insufficient_privilege, raised by
        // upsert_master_canvas_module for a non-owner/admin caller.
        // 22023 = invalid_parameter_value, raised for an unrecognised
        // module key/enabled combination.
        if (isPgErrorWithCode(error, '42501')) return { outcome: 'forbidden' };
        if (isPgErrorWithCode(error, '22023')) return { outcome: 'invalid' };
        throw error;
      }
    },
  };
}

export function createSqlMasterCanvasOverlayStore(sql: Sql): MasterCanvasOverlayStore {
  return {
    async listActiveForOverlay(token, overlayId) {
      const rows = await sql<{ module_key: MasterCanvasModuleKey }[]>`
        select module_key
          from app_private.list_overlay_master_canvas_modules(${overlayId}::uuid, ${fingerprint(token)})
      `;
      return rows.map((row) => row.module_key);
    },
  };
}
