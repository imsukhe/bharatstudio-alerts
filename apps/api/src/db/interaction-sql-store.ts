// L16 (packages/db/migrations/0105). Mirrors apps/api/src/db/goal-store.ts's
// own inUserTransaction/error-matching conventions exactly — this file owns
// its own copy rather than importing goal-store.ts's (that file is not
// shared infrastructure, and every other *-store.ts in this directory
// already carries its own copy of the same helper).
import type { Sql, TransactionSql } from 'postgres';
import type {
  CastVoteResult,
  CreateDefinitionResult,
  CreateInteractionDefinitionInput,
  CreateVoteOptionResult,
  CreateWidgetConfigInput,
  CreateWidgetResult,
  HypeLifecycleResult,
  HypeModeState,
  HypeModeStore,
  InteractionDefinition,
  InteractionDefinitionStore,
  InteractionOverlayStore,
  InteractionType,
  Leaderboard,
  LeaderboardStore,
  LeaderboardWindow,
  ModerationRule,
  MutateDefinitionResult,
  MutateWidgetResult,
  PublicVoteStore,
  SupportVoteStore,
  UpdateInteractionDefinitionInput,
  UpdateWidgetConfigInput,
  VoteTally,
  WidgetConfig,
  WidgetConfigStore,
  WidgetType,
} from '../domain/interaction-types.js';

async function inUserTransaction<T>(sql: Sql, userId: string, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return callback(tx);
  });
  return result as T;
}

function isPgErrorWithMessage(error: unknown, substring: string): boolean {
  return error instanceof Error && error.message.includes(substring);
}

type DefinitionRow = {
  definition_id: string;
  interaction_type: InteractionType;
  label: string;
  amount_paise: string | number | null;
  queue_id: string;
  tts_enabled: boolean;
  moderation_rule: ModerationRule;
  visual: unknown;
  config: unknown;
  is_enabled: boolean;
  closed: boolean;
  created_at: Date;
  updated_at: Date;
};

function toDefinition(channelId: string, row: DefinitionRow): InteractionDefinition {
  return {
    schemaVersion: 'v1',
    definitionId: row.definition_id,
    channelId,
    interactionType: row.interaction_type,
    label: row.label,
    amountPaise: row.amount_paise === null ? null : Number(row.amount_paise),
    queueId: row.queue_id,
    ttsEnabled: row.tts_enabled,
    moderationRule: row.moderation_rule,
    visual: (row.visual ?? {}) as Record<string, unknown>,
    config: (row.config ?? {}) as Record<string, unknown>,
    isEnabled: row.is_enabled,
    closed: row.closed,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function createSqlInteractionDefinitionStore(sql: Sql): InteractionDefinitionStore {
  async function listOnce(tx: TransactionSql | Sql, channelId: string): Promise<InteractionDefinition[]> {
    const rows = await tx<DefinitionRow[]>`
      select definition_id, interaction_type, label, amount_paise, queue_id, tts_enabled, moderation_rule, visual, config, is_enabled, closed, created_at, updated_at
        from app_private.list_channel_interaction_definitions(${channelId}::uuid)
    `;
    return rows.map((row) => toDefinition(channelId, row));
  }

  return {
    async create(userId, channelId, input: CreateInteractionDefinitionInput): Promise<CreateDefinitionResult> {
      try {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<{ create_interaction_definition: string }[]>`
          select app_private.create_interaction_definition(
            ${channelId}::uuid, ${input.interactionType}, ${input.label}, ${input.amountPaise ?? null}::bigint,
            ${input.queueId}::uuid, ${input.ttsEnabled ?? false}, ${input.moderationRule ?? 'review'},
            ${JSON.stringify(input.visual ?? {})}::jsonb, ${JSON.stringify(input.config ?? {})}::jsonb
          )
        `);
        const definitionId = rows[0]?.create_interaction_definition;
        if (!definitionId) return { outcome: 'invalid' };
        const items = await inUserTransaction(sql, userId, (tx) => listOnce(tx, channelId));
        const created = items.find((item) => item.definitionId === definitionId);
        return created ? { outcome: 'created', definition: created } : { outcome: 'invalid' };
      } catch (error) {
        if (isPgErrorWithMessage(error, 'interaction definition limit reached')) return { outcome: 'tier_limit_reached' };
        if (isPgErrorWithMessage(error, 'not authorized')) return { outcome: 'forbidden' };
        if (isPgErrorWithMessage(error, 'invalid interaction definition')) return { outcome: 'invalid' };
        throw error;
      }
    },

    async list(userId, channelId): Promise<InteractionDefinition[]> {
      return inUserTransaction(sql, userId, (tx) => listOnce(tx, channelId));
    },

    async update(userId, channelId, definitionId, input: UpdateInteractionDefinitionInput): Promise<MutateDefinitionResult> {
      try {
        await inUserTransaction(sql, userId, (tx) => tx`
          select app_private.update_interaction_definition(
            ${channelId}::uuid, ${definitionId}::uuid, ${input.label ?? null}, ${input.amountPaise ?? null}::bigint,
            ${input.ttsEnabled ?? null}, ${input.moderationRule ?? null},
            ${input.visual ? JSON.stringify(input.visual) : null}::jsonb, ${input.isEnabled ?? null}
          )
        `);
      } catch (error) {
        if (isPgErrorWithMessage(error, 'not authorized')) return { outcome: 'forbidden' };
        if (isPgErrorWithMessage(error, 'interaction definition not found')) return { outcome: 'not_found' };
        if (isPgErrorWithMessage(error, 'invalid interaction definition')) return { outcome: 'invalid' };
        throw error;
      }
      const items = await inUserTransaction(sql, userId, (tx) => listOnce(tx, channelId));
      const updated = items.find((item) => item.definitionId === definitionId);
      return updated ? { outcome: 'ok', definition: updated } : { outcome: 'not_found' };
    },

    async close(userId, channelId, definitionId): Promise<MutateDefinitionResult> {
      try {
        await inUserTransaction(sql, userId, (tx) => tx`select app_private.close_interaction_definition(${channelId}::uuid, ${definitionId}::uuid)`);
      } catch (error) {
        if (isPgErrorWithMessage(error, 'not authorized')) return { outcome: 'forbidden' };
        if (isPgErrorWithMessage(error, 'interaction definition not found')) return { outcome: 'not_found' };
        throw error;
      }
      const items = await inUserTransaction(sql, userId, (tx) => listOnce(tx, channelId));
      const closed = items.find((item) => item.definitionId === definitionId);
      return closed ? { outcome: 'ok', definition: closed } : { outcome: 'not_found' };
    },
  };
}

type VoteTallyRowDb = { option_key: string; label: string; vote_count: string | number; resolved: boolean; resolved_option_key: string | null };

function toVoteTally(rows: VoteTallyRowDb[]): VoteTally | null {
  const first = rows[0];
  if (!first) return null;
  return {
    schemaVersion: 'v1',
    options: rows.map((row) => ({ optionKey: row.option_key, label: row.label, voteCount: Number(row.vote_count) })),
    resolved: first.resolved,
    resolvedOptionKey: first.resolved_option_key,
  };
}

export function createSqlSupportVoteStore(sql: Sql): SupportVoteStore {
  return {
    async createOption(userId, channelId, definitionId, optionKey, label): Promise<CreateVoteOptionResult> {
      try {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<{ create_vote_option: string }[]>`
          select app_private.create_vote_option(${channelId}::uuid, ${definitionId}::uuid, ${optionKey}, ${label})
        `);
        const optionId = rows[0]?.create_vote_option;
        return optionId ? { outcome: 'created', optionId } : { outcome: 'invalid' };
      } catch (error) {
        if (isPgErrorWithMessage(error, 'not authorized')) return { outcome: 'forbidden' };
        if (isPgErrorWithMessage(error, 'interaction definition not found')) return { outcome: 'not_found' };
        if (isPgErrorWithMessage(error, 'invalid vote option') || isPgErrorWithMessage(error, 'closed support vote') || isPgErrorWithMessage(error, 'support vote option limit reached')) return { outcome: 'invalid' };
        throw error;
      }
    },

    async tally(userId, channelId, definitionId): Promise<VoteTally | null> {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<VoteTallyRowDb[]>`
        select option_key, label, vote_count, resolved, resolved_option_key
          from app_private.support_vote_tally(${channelId}::uuid, ${definitionId}::uuid)
      `);
      return toVoteTally(rows);
    },
  };
}

export function createSqlPublicVoteStore(sql: Sql): PublicVoteStore {
  return {
    async cast(definitionId, optionKey, voterFingerprint): Promise<CastVoteResult> {
      try {
        const rows = await sql<{ cast_support_vote: boolean }[]>`
          select app_private.cast_support_vote(${definitionId}::uuid, ${optionKey}, ${voterFingerprint})
        `;
        return { outcome: rows[0]?.cast_support_vote ? 'counted' : 'already_voted' };
      } catch {
        return { outcome: 'invalid' };
      }
    },
  };
}

type HypeStateRow = { meter_paise: string | number; threshold_paise: string | number; reached: boolean; started_at: Date; ends_at: Date; ended: boolean };

function toHypeState(rows: HypeStateRow[]): HypeModeState {
  const row = rows[0];
  if (!row) return null;
  return {
    schemaVersion: 'v1',
    meterPaise: Number(row.meter_paise),
    thresholdPaise: Number(row.threshold_paise),
    reached: row.reached,
    startedAt: row.started_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    ended: row.ended,
  };
}

export function createSqlHypeModeStore(sql: Sql): HypeModeStore {
  return {
    async start(userId, channelId, definitionId, durationSeconds): Promise<HypeLifecycleResult> {
      try {
        await inUserTransaction(sql, userId, (tx) => tx`select app_private.start_hype_mode(${channelId}::uuid, ${definitionId}::uuid, ${durationSeconds})`);
        return { outcome: 'ok' };
      } catch (error) {
        if (isPgErrorWithMessage(error, 'not authorized')) return { outcome: 'forbidden' };
        if (isPgErrorWithMessage(error, 'interaction definition not found')) return { outcome: 'not_found' };
        if (isPgErrorWithMessage(error, 'invalid hype mode') || isPgErrorWithMessage(error, 'not active')) return { outcome: 'invalid' };
        throw error;
      }
    },

    async end(userId, channelId, definitionId): Promise<HypeLifecycleResult> {
      try {
        await inUserTransaction(sql, userId, (tx) => tx`select app_private.end_hype_mode(${channelId}::uuid, ${definitionId}::uuid)`);
        return { outcome: 'ok' };
      } catch (error) {
        if (isPgErrorWithMessage(error, 'not authorized')) return { outcome: 'forbidden' };
        throw error;
      }
    },

    async get(userId, channelId, definitionId): Promise<HypeModeState> {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<HypeStateRow[]>`
        select meter_paise, threshold_paise, reached, started_at, ends_at, ended
          from app_private.get_channel_hype_mode(${channelId}::uuid, ${definitionId}::uuid)
      `);
      return toHypeState(rows);
    },
  };
}

type WidgetRow = {
  widget_config_id: string; widget_type: WidgetType; placement: unknown; style: unknown; data_source: unknown;
  privacy_scope: 'private' | 'public'; is_enabled: boolean; created_at: Date; updated_at: Date;
};

function toWidget(channelId: string, row: WidgetRow): WidgetConfig {
  return {
    schemaVersion: 'v1',
    widgetConfigId: row.widget_config_id,
    channelId,
    widgetType: row.widget_type,
    placement: (row.placement ?? {}) as Record<string, unknown>,
    style: (row.style ?? {}) as Record<string, unknown>,
    dataSource: (row.data_source ?? {}) as Record<string, unknown>,
    privacyScope: row.privacy_scope,
    isEnabled: row.is_enabled,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function createSqlWidgetConfigStore(sql: Sql): WidgetConfigStore {
  async function listOnce(tx: TransactionSql | Sql, channelId: string): Promise<WidgetConfig[]> {
    const rows = await tx<WidgetRow[]>`
      select widget_config_id, widget_type, placement, style, data_source, privacy_scope, is_enabled, created_at, updated_at
        from app_private.list_channel_widget_configs(${channelId}::uuid)
    `;
    return rows.map((row) => toWidget(channelId, row));
  }

  return {
    async create(userId, channelId, input: CreateWidgetConfigInput): Promise<CreateWidgetResult> {
      try {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<{ create_widget_config: string }[]>`
          select app_private.create_widget_config(
            ${channelId}::uuid, ${input.widgetType}, ${JSON.stringify(input.placement ?? {})}::jsonb,
            ${JSON.stringify(input.style ?? {})}::jsonb, ${JSON.stringify(input.dataSource ?? {})}::jsonb, ${input.privacyScope ?? 'private'}
          )
        `);
        const widgetConfigId = rows[0]?.create_widget_config;
        if (!widgetConfigId) return { outcome: 'invalid' };
        const items = await inUserTransaction(sql, userId, (tx) => listOnce(tx, channelId));
        const created = items.find((item) => item.widgetConfigId === widgetConfigId);
        return created ? { outcome: 'created', widget: created } : { outcome: 'invalid' };
      } catch (error) {
        if (isPgErrorWithMessage(error, 'widget limit reached')) return { outcome: 'tier_limit_reached' };
        if (isPgErrorWithMessage(error, 'not authorized')) return { outcome: 'forbidden' };
        if (isPgErrorWithMessage(error, 'invalid widget config')) return { outcome: 'invalid' };
        throw error;
      }
    },

    async list(userId, channelId): Promise<WidgetConfig[]> {
      return inUserTransaction(sql, userId, (tx) => listOnce(tx, channelId));
    },

    async update(userId, channelId, widgetConfigId, input: UpdateWidgetConfigInput): Promise<MutateWidgetResult> {
      try {
        await inUserTransaction(sql, userId, (tx) => tx`
          select app_private.update_widget_config(
            ${channelId}::uuid, ${widgetConfigId}::uuid,
            ${input.placement ? JSON.stringify(input.placement) : null}::jsonb,
            ${input.style ? JSON.stringify(input.style) : null}::jsonb,
            ${input.dataSource ? JSON.stringify(input.dataSource) : null}::jsonb,
            ${input.privacyScope ?? null}, ${input.isEnabled ?? null}
          )
        `);
      } catch (error) {
        if (isPgErrorWithMessage(error, 'not authorized')) return { outcome: 'forbidden' };
        if (isPgErrorWithMessage(error, 'widget config not found')) return { outcome: 'not_found' };
        if (isPgErrorWithMessage(error, 'invalid widget config')) return { outcome: 'invalid' };
        throw error;
      }
      const items = await inUserTransaction(sql, userId, (tx) => listOnce(tx, channelId));
      const updated = items.find((item) => item.widgetConfigId === widgetConfigId);
      return updated ? { outcome: 'ok', widget: updated } : { outcome: 'not_found' };
    },

    async remove(userId, channelId, widgetConfigId): Promise<MutateWidgetResult> {
      try {
        await inUserTransaction(sql, userId, (tx) => tx`select app_private.delete_widget_config(${channelId}::uuid, ${widgetConfigId}::uuid)`);
        return { outcome: 'ok' };
      } catch (error) {
        if (isPgErrorWithMessage(error, 'not authorized')) return { outcome: 'forbidden' };
        if (isPgErrorWithMessage(error, 'widget config not found')) return { outcome: 'not_found' };
        throw error;
      }
    },
  };
}

type LeaderboardRowDb = { rank: number; viewer_ref: string; tier_label: string };

export function createSqlLeaderboardStore(sql: Sql): LeaderboardStore {
  return {
    async get(userId, channelId, window: LeaderboardWindow): Promise<Leaderboard> {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<LeaderboardRowDb[]>`
        select rank, viewer_ref, tier_label from app_private.get_channel_leaderboard(${channelId}::uuid, ${window})
      `);
      return { schemaVersion: 'v1', window, rows: rows.map((row) => ({ rank: row.rank, viewerRef: row.viewer_ref, tierLabel: row.tier_label })) };
    },
  };
}

// --- Overlay reads: sha256 fingerprint of the bearer token, matched
// against overlay_sessions.token_fingerprint inside each SECURITY DEFINER
// function — identical to db/goal-overlay-store.ts and
// db/overlay-branding-store.ts. No new auth path.
import { createHash } from 'node:crypto';

function fingerprint(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function createSqlInteractionOverlayStore(sql: Sql): InteractionOverlayStore {
  return {
    async getWidgetConfig(token, overlayId, widgetType) {
      const rows = await sql<{ widget_config_id: string; widget_type: WidgetType; placement: unknown; style: unknown; data_source: unknown }[]>`
        select widget_config_id, widget_type, placement, style, data_source
          from app_private.list_overlay_widget_config(${overlayId}::uuid, ${fingerprint(token)}, ${widgetType})
      `;
      const row = rows[0];
      if (!row) return null;
      return {
        widgetConfigId: row.widget_config_id,
        widgetType: row.widget_type,
        placement: (row.placement ?? {}) as Record<string, unknown>,
        style: (row.style ?? {}) as Record<string, unknown>,
        dataSource: (row.data_source ?? {}) as Record<string, unknown>,
      };
    },

    async getVoteTally(token, overlayId, definitionId) {
      const rows = await sql<VoteTallyRowDb[]>`
        select option_key, label, vote_count, resolved, resolved_option_key
          from app_private.list_overlay_vote_tally(${overlayId}::uuid, ${fingerprint(token)}, ${definitionId}::uuid)
      `;
      return toVoteTally(rows);
    },

    async getHypeMode(token, overlayId, definitionId) {
      const rows = await sql<HypeStateRow[]>`
        select meter_paise, threshold_paise, reached, started_at, ends_at, ended
          from app_private.list_overlay_hype_mode(${overlayId}::uuid, ${fingerprint(token)}, ${definitionId}::uuid)
      `;
      return toHypeState(rows);
    },

    async getLeaderboard(token, overlayId, window) {
      const rows = await sql<LeaderboardRowDb[]>`
        select rank, viewer_ref, tier_label
          from app_private.list_overlay_leaderboard(${overlayId}::uuid, ${fingerprint(token)}, ${window})
      `;
      return { schemaVersion: 'v1', window, rows: rows.map((row) => ({ rank: row.rank, viewerRef: row.viewer_ref, tierLabel: row.tier_label })) };
    },
  };
}
