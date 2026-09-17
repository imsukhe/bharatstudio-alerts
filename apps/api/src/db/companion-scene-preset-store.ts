import type { Sql, TransactionSql } from 'postgres';
import type {
  AddScenePresetActionInput,
  AddScenePresetActionResult,
  CompanionScenePresetStore,
  ScenePreset,
  ScenePresetAction,
  ScenePresetActionType,
  ScenePresetName,
  UpsertScenePresetResult,
} from '../domain/companion-scene-preset-store.js';

async function inUserTransaction<T>(sql: Sql, userId: string, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return callback(tx);
  });
  return result as T;
}

function isPgErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === code;
}

type PresetRow = { preset_id: string; preset_name: ScenePresetName; created_at: Date; updated_at: Date };
type ActionRow = { action_id: string; step_order: number; action_type: ScenePresetActionType; target_label: string };

function toPreset(channelId: string, row: PresetRow): ScenePreset {
  return {
    schemaVersion: 'v1',
    presetId: row.preset_id,
    channelId,
    presetName: row.preset_name,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toAction(row: ActionRow): ScenePresetAction {
  return { schemaVersion: 'v1', actionId: row.action_id, stepOrder: row.step_order, actionType: row.action_type, targetLabel: row.target_label };
}

export function createSqlCompanionScenePresetStore(sql: Sql): CompanionScenePresetStore {
  return {
    async upsert(userId, channelId, presetName: ScenePresetName): Promise<UpsertScenePresetResult> {
      try {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<{ upsert_companion_scene_preset: string }[]>`
          select app_private.upsert_companion_scene_preset(${channelId}::uuid, ${presetName})
        `);
        const presetId = rows[0]?.upsert_companion_scene_preset;
        return presetId ? { outcome: 'ok', presetId } : { outcome: 'invalid' };
      } catch (error) {
        if (isPgErrorWithCode(error, '42501')) return { outcome: 'forbidden' };
        if (isPgErrorWithCode(error, '22023')) return { outcome: 'invalid' };
        throw error;
      }
    },

    async list(userId, channelId): Promise<ScenePreset[]> {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<PresetRow[]>`
        select preset_id, preset_name, created_at, updated_at
          from app_private.list_channel_scene_presets(${channelId}::uuid)
      `);
      return rows.map((row) => toPreset(channelId, row));
    },

    async addAction(userId, channelId, presetId, input: AddScenePresetActionInput): Promise<AddScenePresetActionResult> {
      try {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<{ add_companion_scene_preset_action: string }[]>`
          select app_private.add_companion_scene_preset_action(
            ${channelId}::uuid, ${presetId}::uuid, ${input.stepOrder}, ${input.actionType}, ${input.targetLabel}
          )
        `);
        const actionId = rows[0]?.add_companion_scene_preset_action;
        return actionId ? { outcome: 'ok', actionId } : { outcome: 'invalid' };
      } catch (error) {
        if (isPgErrorWithCode(error, '42501')) return { outcome: 'forbidden' };
        if (isPgErrorWithCode(error, 'P0002')) return { outcome: 'not_found' };
        if (isPgErrorWithCode(error, '22023') || isPgErrorWithCode(error, '23505')) return { outcome: 'invalid' };
        throw error;
      }
    },

    async listActions(userId, channelId, presetId): Promise<ScenePresetAction[] | null> {
      try {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<ActionRow[]>`
          select action_id, step_order, action_type, target_label
            from app_private.list_companion_scene_preset_actions(${channelId}::uuid, ${presetId}::uuid)
        `);
        return rows.map(toAction);
      } catch (error) {
        if (isPgErrorWithCode(error, '42501') || isPgErrorWithCode(error, 'P0002')) return null;
        throw error;
      }
    },
  };
}
