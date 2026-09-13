import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { requireAuth, requireAuthAndTerms } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import type { AccountStore } from '../domain/account-store.js';
import type {
  HypeModeStore,
  HypeModeState,
  InteractionDefinitionStore,
  InteractionOverlayStore,
  InteractionType,
  Leaderboard,
  LeaderboardStore,
  LeaderboardWindow,
  ModerationRule,
  PublicVoteStore,
  SupportVoteStore,
  VoteTally,
  WidgetConfigStore,
  WidgetConfig,
  WidgetType,
} from '../domain/interaction-types.js';
// L16 gap closure (0108): paid support votes. Separate types/store files
// (not domain/interaction-types.ts or db/interaction-sql-store.ts — this
// lane's ownership boundary is new files prefixed vote-payment- only), so
// every existing consumer of the types above is untouched.
import type { PaidSupportVoteStore, PaidVoteOverlayStore, PaidVoteTally } from '../domain/vote-payment-types.js';
import type { ContributionSourceStore, ContributionSourceType } from '../domain/contribution-source-types.js';
import { logSafeError } from '../observability/safe-log.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const interactionTypes: readonly InteractionType[] = ['tip', 'tts_tip', 'sticker', 'mega_alert', 'priority_question', 'support_vote', 'community_goal', 'hype_mode'];
const contributionSourceTypes: readonly ContributionSourceType[] = ['payment', 'youtube_superchat'];

const sourceInclusionBody = {
  type: 'object', additionalProperties: false, required: ['sourceType', 'included'],
  properties: {
    sourceType: { type: 'string', enum: [...contributionSourceTypes] },
    included: { type: 'boolean' },
  },
} as const;
const moderationRules: readonly ModerationRule[] = ['none', 'review', 'block_list'];
const widgetTypes: readonly WidgetType[] = ['main_alert', 'support_goal', 'recent_tips', 'top_supporters', 'supporter_ticker', 'public_leaderboard', 'mega_tip_banner'];
const leaderboardWindows: readonly LeaderboardWindow[] = ['weekly', 'monthly', 'all'];

const channelParams = { type: 'object', additionalProperties: false, required: ['channelId'], properties: { channelId: uuid } } as const;
const definitionParams = { type: 'object', additionalProperties: false, required: ['channelId', 'definitionId'], properties: { channelId: uuid, definitionId: uuid } } as const;
const widgetParams = { type: 'object', additionalProperties: false, required: ['channelId', 'widgetConfigId'], properties: { channelId: uuid, widgetConfigId: uuid } } as const;
const overlayParams = { type: 'object', additionalProperties: false, required: ['overlayId'], properties: { overlayId: uuid } } as const;
const overlayDefinitionParams = { type: 'object', additionalProperties: false, required: ['overlayId', 'definitionId'], properties: { overlayId: uuid, definitionId: uuid } } as const;
const overlayWidgetTypeParams = { type: 'object', additionalProperties: false, required: ['overlayId', 'widgetType'], properties: { overlayId: uuid, widgetType: { type: 'string', enum: [...widgetTypes] } } } as const;
const leaderboardQuery = { type: 'object', additionalProperties: false, properties: { window: { type: 'string', enum: [...leaderboardWindows], default: 'all' } } } as const;

const createDefinitionBody = {
  type: 'object', additionalProperties: false, required: ['interactionType', 'label', 'queueId'],
  properties: {
    interactionType: { type: 'string', enum: [...interactionTypes] },
    label: { type: 'string', minLength: 1, maxLength: 120 },
    amountPaise: { type: ['integer', 'null'], minimum: 1000 },
    queueId: uuid,
    ttsEnabled: { type: 'boolean' },
    moderationRule: { type: 'string', enum: [...moderationRules] },
    visual: { type: 'object' },
    config: { type: 'object' },
  },
} as const;

const updateDefinitionBody = {
  type: 'object', additionalProperties: false, minProperties: 1,
  properties: {
    label: { type: 'string', minLength: 1, maxLength: 120 },
    amountPaise: { type: ['integer', 'null'], minimum: 1000 },
    ttsEnabled: { type: 'boolean' },
    moderationRule: { type: 'string', enum: [...moderationRules] },
    visual: { type: 'object' },
    isEnabled: { type: 'boolean' },
  },
} as const;

const createVoteOptionBody = {
  type: 'object', additionalProperties: false, required: ['optionKey', 'label'],
  properties: { optionKey: { type: 'string', pattern: '^[a-z0-9_-]{1,40}$' }, label: { type: 'string', minLength: 1, maxLength: 120 } },
} as const;

const castVoteBody = {
  type: 'object', additionalProperties: false, required: ['optionKey', 'voterFingerprint'],
  properties: { optionKey: { type: 'string', pattern: '^[a-z0-9_-]{1,40}$' }, voterFingerprint: { type: 'string', minLength: 8, maxLength: 128 } },
} as const;

const startHypeBody = {
  type: 'object', additionalProperties: false, required: ['durationSeconds'],
  properties: { durationSeconds: { type: 'integer', minimum: 30, maximum: 3600 } },
} as const;

const createWidgetBody = {
  type: 'object', additionalProperties: false, required: ['widgetType'],
  properties: {
    widgetType: { type: 'string', enum: [...widgetTypes] },
    placement: { type: 'object' },
    style: { type: 'object' },
    dataSource: { type: 'object' },
    privacyScope: { type: 'string', enum: ['private', 'public'] },
  },
} as const;

const updateWidgetBody = {
  type: 'object', additionalProperties: false, minProperties: 1,
  properties: {
    placement: { type: 'object' },
    style: { type: 'object' },
    dataSource: { type: 'object' },
    privacyScope: { type: 'string', enum: ['private', 'public'] },
    isEnabled: { type: 'boolean' },
  },
} as const;

type ReplyLike = { code: (status: number) => { send: (body: unknown) => unknown } };

function unavailable(reply: ReplyLike, traceId: string) {
  return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'interaction_store_unavailable', message: 'Interaction configuration is temporarily unavailable', traceId, retryable: true });
}

function overlayUnavailable(reply: ReplyLike, traceId: string, message: string) {
  return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'interaction_store_unavailable', message, traceId, retryable: true });
}

// Overlay stores deliberately return domain objects rather than API DTOs. Keep
// the browser boundary explicit: a future store field (account, channel,
// provider, payment, token, refund, or operational metadata) cannot cross it
// merely because it was added to an internal type.
function projectOverlayVoteTally(tally: VoteTally | null) {
  return tally === null ? null : {
    schemaVersion: 'v1' as const,
    options: tally.options.map((option) => ({ optionKey: option.optionKey, label: option.label, voteCount: option.voteCount })),
    resolved: tally.resolved,
    resolvedOptionKey: tally.resolvedOptionKey,
  };
}

function projectOverlayHype(state: HypeModeState) {
  return state === null ? null : {
    schemaVersion: 'v1' as const,
    meterPaise: state.meterPaise,
    thresholdPaise: state.thresholdPaise,
    reached: state.reached,
    startedAt: state.startedAt,
    endsAt: state.endsAt,
    ended: state.ended,
  };
}

function projectOverlayLeaderboard(board: Leaderboard | null) {
  return board === null ? null : {
    schemaVersion: 'v1' as const,
    window: board.window,
    rows: board.rows.map((row) => ({ rank: row.rank, viewerRef: row.viewerRef, tierLabel: row.tierLabel })),
  };
}

function projectOverlayPaidVoteTally(tally: PaidVoteTally | null) {
  return tally === null ? null : {
    schemaVersion: 'v1' as const,
    votingMode: 'paid' as const,
    options: tally.options.map((option) => ({ optionKey: option.optionKey, label: option.label, amountPaise: option.amountPaise })),
    resolved: tally.resolved,
    resolvedOptionKey: tally.resolvedOptionKey,
  };
}

function projectOverlayWidgetConfig(config: Pick<WidgetConfig, 'widgetConfigId' | 'widgetType' | 'placement' | 'style' | 'dataSource'> | null) {
  return config === null ? null : {
    widgetConfigId: config.widgetConfigId,
    widgetType: config.widgetType,
    placement: config.placement,
    style: config.style,
    dataSource: config.dataSource,
  };
}

function bearerToken(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^Bearer\s+([^\s]+)$/i.exec(value);
  return match?.[1];
}

function sendDefinitionMutate(reply: ReplyLike, traceId: string, result: { outcome: 'ok'; definition: unknown } | { outcome: 'forbidden' | 'not_found' | 'invalid' }) {
  switch (result.outcome) {
    case 'ok': return reply.code(200).send(result.definition);
    case 'forbidden': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Interaction definition not found', traceId });
    case 'not_found': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Interaction definition not found', traceId });
    case 'invalid': return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_interaction_definition', message: 'The interaction definition could not be updated', traceId });
  }
}

export async function registerInteractionRoutes(
  app: FastifyInstance,
  sessions?: SessionStore,
  account?: AccountStore,
  definitions?: InteractionDefinitionStore,
  votes?: SupportVoteStore,
  publicVotes?: PublicVoteStore,
  hype?: HypeModeStore,
  widgets?: WidgetConfigStore,
  leaderboard?: LeaderboardStore,
  overlay?: InteractionOverlayStore,
  // --- L16 gap-closure additions (0108). These optional dependencies keep
  // unit callers able to prove their fail-closed behavior; production passes
  // all three from buildApp/index when a SQL client is configured.
  paidVotes?: PaidSupportVoteStore,
  paidVoteOverlay?: PaidVoteOverlayStore,
  // Raw client for the four new widget overlay reads (recent_tips,
  // top_supporters, supporter_ticker, mega_tip_banner). These are simple,
  // read-only, single-purpose SECURITY DEFINER function calls with no
  // mutation and no channel-role branching — a full store abstraction
  // would just wrap one query each, so they are queried directly here
  // rather than adding a same-shape *Store file outside this lane's
  // vote-payment- file-naming boundary.
  widgetOverlaySql?: Sql,
  // L16c (0117): per-hype-mode-definition external-contribution source
  // inclusion. New file (domain/contribution-source-types.ts, this lane's
  // own "contribution-" naming boundary), trailing/optional so no existing
  // positional caller of this function is disturbed.
  contributionSources?: ContributionSourceStore,
): Promise<void> {
  const auth = requireAuth(sessions);
  const termsAuth = requireAuthAndTerms(sessions, account);

  // --- interaction_definitions -------------------------------------------

  app.post<{ Params: { channelId: string }; Body: {
    interactionType: InteractionType; label: string; amountPaise?: number | null; queueId: string;
    ttsEnabled?: boolean; moderationRule?: ModerationRule; visual?: Record<string, unknown>; config?: Record<string, unknown>;
  } }>('/v1/channels/:channelId/interactions', { preHandler: termsAuth, schema: { params: channelParams, body: createDefinitionBody } }, async (request, reply) => {
    if (!definitions || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await definitions.create(request.auth.userId, request.params.channelId, request.body);
      switch (result.outcome) {
        case 'created': return reply.code(201).send(result.definition);
        case 'forbidden': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Channel not found', traceId: request.id });
        case 'tier_limit_reached': return reply.code(403).send({ schemaVersion: 'v1', errorCode: 'interaction_limit_reached', message: "This tier's interaction limit has been reached", traceId: request.id });
        case 'invalid': return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_interaction_definition', message: 'The interaction definition could not be created', traceId: request.id });
      }
    } catch (error) {
      logSafeError(request, 'interaction_definition_create_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'interaction_store_unavailable', message: 'The interaction definition could not be created', traceId: request.id, retryable: true });
    }
  });

  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/interactions', { preHandler: auth, schema: { params: channelParams } }, async (request, reply) => {
    if (!definitions || !request.auth) return unavailable(reply, request.id);
    try {
      const items = await definitions.list(request.auth.userId, request.params.channelId);
      return reply.code(200).send({ schemaVersion: 'v1', items });
    } catch (error) {
      logSafeError(request, 'interaction_definition_list_failed', error);
      return unavailable(reply, request.id);
    }
  });

  app.patch<{ Params: { channelId: string; definitionId: string }; Body: {
    label?: string; amountPaise?: number | null; ttsEnabled?: boolean; moderationRule?: ModerationRule; visual?: Record<string, unknown>; isEnabled?: boolean;
  } }>('/v1/channels/:channelId/interactions/:definitionId', { preHandler: termsAuth, schema: { params: definitionParams, body: updateDefinitionBody } }, async (request, reply) => {
    if (!definitions || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await definitions.update(request.auth.userId, request.params.channelId, request.params.definitionId, request.body);
      return sendDefinitionMutate(reply, request.id, result);
    } catch (error) {
      logSafeError(request, 'interaction_definition_update_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'interaction_store_unavailable', message: 'The interaction definition could not be updated', traceId: request.id, retryable: true });
    }
  });

  app.post<{ Params: { channelId: string; definitionId: string } }>('/v1/channels/:channelId/interactions/:definitionId/close', { preHandler: termsAuth, schema: { params: definitionParams } }, async (request, reply) => {
    if (!definitions || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await definitions.close(request.auth.userId, request.params.channelId, request.params.definitionId);
      return sendDefinitionMutate(reply, request.id, result);
    } catch (error) {
      logSafeError(request, 'interaction_definition_close_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'interaction_store_unavailable', message: 'The interaction definition could not be closed', traceId: request.id, retryable: true });
    }
  });

  // --- support votes -------------------------------------------------------

  app.post<{ Params: { channelId: string; definitionId: string }; Body: { optionKey: string; label: string } }>(
    '/v1/channels/:channelId/interactions/:definitionId/vote-options',
    { preHandler: termsAuth, schema: { params: definitionParams, body: createVoteOptionBody } },
    async (request, reply) => {
      if (!votes || !request.auth) return unavailable(reply, request.id);
      try {
        const result = await votes.createOption(request.auth.userId, request.params.channelId, request.params.definitionId, request.body.optionKey, request.body.label);
        switch (result.outcome) {
          case 'created': return reply.code(201).send({ schemaVersion: 'v1', optionId: result.optionId });
          case 'forbidden': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Interaction definition not found', traceId: request.id });
          case 'not_found': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Interaction definition not found', traceId: request.id });
          case 'invalid': return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_vote_option', message: 'The vote option could not be created', traceId: request.id });
        }
      } catch (error) {
        logSafeError(request, 'vote_option_create_failed', error);
        return unavailable(reply, request.id);
      }
    },
  );

  app.get<{ Params: { channelId: string; definitionId: string } }>('/v1/channels/:channelId/interactions/:definitionId/vote-tally', { preHandler: auth, schema: { params: definitionParams } }, async (request, reply) => {
    if (!votes || !request.auth) return unavailable(reply, request.id);
    try {
      const tally = await votes.tally(request.auth.userId, request.params.channelId, request.params.definitionId);
      return reply.code(200).send({ schemaVersion: 'v1', tally });
    } catch (error) {
      logSafeError(request, 'vote_tally_read_failed', error);
      return unavailable(reply, request.id);
    }
  });

  // L16 gap closure (0108): the money-derived tally for a support_vote
  // definition whose config.votingMode === 'paid'. A caller decides which
  // of this route or the headcount one above to call by reading the
  // definition's own config (returned from GET .../interactions) —
  // votingMode absent or anything but 'paid' means the free/headcount
  // route above is the correct one; this route on a free-mode definition
  // simply returns a null tally (paid_support_vote_tally finds no tagged
  // payments for it, same "degrade to empty, never throw" shape).
  app.get<{ Params: { channelId: string; definitionId: string } }>('/v1/channels/:channelId/interactions/:definitionId/paid-vote-tally', { preHandler: auth, schema: { params: definitionParams } }, async (request, reply) => {
    if (!paidVotes || !request.auth) return unavailable(reply, request.id);
    try {
      const tally = await paidVotes.tally(request.auth.userId, request.params.channelId, request.params.definitionId);
      return reply.code(200).send({ schemaVersion: 'v1', tally });
    } catch (error) {
      logSafeError(request, 'paid_vote_tally_read_failed', error);
      return unavailable(reply, request.id);
    }
  });

  // Public/viewer vote cast — deliberately outside the session-cookie auth
  // chain (an anonymous stream viewer casts this), same "public route,
  // narrow validated body, all real gating inside the SECURITY DEFINER
  // function" shape as the existing public tip-order route.
  app.post<{ Params: { definitionId: string }; Body: { optionKey: string; voterFingerprint: string } }>(
    '/v1/public/interactions/:definitionId/votes',
    { schema: { params: { type: 'object', additionalProperties: false, required: ['definitionId'], properties: { definitionId: uuid } }, body: castVoteBody } },
    async (request, reply) => {
      if (!publicVotes) return unavailable(reply, request.id);
      try {
        const result = await publicVotes.cast(request.params.definitionId, request.body.optionKey, request.body.voterFingerprint);
        if (result.outcome === 'invalid') return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_vote', message: 'This vote could not be counted', traceId: request.id });
        return reply.code(200).send({ schemaVersion: 'v1', counted: result.outcome === 'counted' });
      } catch (error) {
        logSafeError(request, 'public_vote_cast_failed', error);
        return unavailable(reply, request.id);
      }
    },
  );

  // --- hype mode -------------------------------------------------------

  app.post<{ Params: { channelId: string; definitionId: string }; Body: { durationSeconds: number } }>(
    '/v1/channels/:channelId/interactions/:definitionId/hype/start',
    { preHandler: termsAuth, schema: { params: definitionParams, body: startHypeBody } },
    async (request, reply) => {
      if (!hype || !request.auth) return unavailable(reply, request.id);
      try {
        const result = await hype.start(request.auth.userId, request.params.channelId, request.params.definitionId, request.body.durationSeconds);
        return sendLifecycleResult(reply, request.id, result);
      } catch (error) {
        logSafeError(request, 'hype_mode_start_failed', error);
        return unavailable(reply, request.id);
      }
    },
  );

  app.post<{ Params: { channelId: string; definitionId: string } }>(
    '/v1/channels/:channelId/interactions/:definitionId/hype/end',
    { preHandler: termsAuth, schema: { params: definitionParams } },
    async (request, reply) => {
      if (!hype || !request.auth) return unavailable(reply, request.id);
      try {
        const result = await hype.end(request.auth.userId, request.params.channelId, request.params.definitionId);
        return sendLifecycleResult(reply, request.id, result);
      } catch (error) {
        logSafeError(request, 'hype_mode_end_failed', error);
        return unavailable(reply, request.id);
      }
    },
  );

  app.get<{ Params: { channelId: string; definitionId: string } }>('/v1/channels/:channelId/interactions/:definitionId/hype', { preHandler: auth, schema: { params: definitionParams } }, async (request, reply) => {
    if (!hype || !request.auth) return unavailable(reply, request.id);
    try {
      const state = await hype.get(request.auth.userId, request.params.channelId, request.params.definitionId);
      return reply.code(200).send({ schemaVersion: 'v1', hype: state });
    } catch (error) {
      logSafeError(request, 'hype_mode_read_failed', error);
      return unavailable(reply, request.id);
    }
  });

  // L16c (0117): which sources count toward this definition's hype meter.
  // Include/exclude ONLY — see domain/contribution-source-types.ts. Scoped
  // to interaction_definition targets (meaningful today for hype_mode; a
  // row on any other definition type is accepted but simply never read by
  // any progress function, same "harmless no-op" posture the rest of this
  // schema takes for a dangling widget data_source reference).
  app.get<{ Params: { channelId: string; definitionId: string } }>('/v1/channels/:channelId/interactions/:definitionId/sources', { preHandler: auth, schema: { params: definitionParams } }, async (request, reply) => {
    if (!contributionSources || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await contributionSources.list(request.auth.userId, request.params.channelId, 'interaction_definition', request.params.definitionId);
      return result.outcome === 'ok'
        ? reply.code(200).send({ schemaVersion: 'v1', sources: result.sources })
        : reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Interaction definition not found', traceId: request.id });
    } catch (error) {
      logSafeError(request, 'interaction_source_list_failed', error);
      return unavailable(reply, request.id);
    }
  });

  app.put<{ Params: { channelId: string; definitionId: string }; Body: { sourceType: ContributionSourceType; included: boolean } }>('/v1/channels/:channelId/interactions/:definitionId/sources', { preHandler: termsAuth, schema: { params: definitionParams, body: sourceInclusionBody } }, async (request, reply) => {
    if (!contributionSources || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await contributionSources.set(
        request.auth.userId, request.params.channelId, 'interaction_definition', request.params.definitionId,
        request.body.sourceType, request.body.included,
      );
      switch (result.outcome) {
        case 'ok': return reply.code(200).send({ schemaVersion: 'v1', sources: result.sources });
        case 'forbidden': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Interaction definition not found', traceId: request.id });
        case 'not_found': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Interaction definition not found', traceId: request.id });
        case 'invalid': return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_source_inclusion', message: 'That contribution source could not be updated', traceId: request.id });
      }
    } catch (error) {
      logSafeError(request, 'interaction_source_update_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'interaction_store_unavailable', message: 'The contribution source could not be updated', traceId: request.id, retryable: true });
    }
  });

  // --- widget_configs -------------------------------------------------------

  app.post<{ Params: { channelId: string }; Body: { widgetType: WidgetType; placement?: Record<string, unknown>; style?: Record<string, unknown>; dataSource?: Record<string, unknown>; privacyScope?: 'private' | 'public' } }>(
    '/v1/channels/:channelId/widgets',
    { preHandler: termsAuth, schema: { params: channelParams, body: createWidgetBody } },
    async (request, reply) => {
      if (!widgets || !request.auth) return unavailable(reply, request.id);
      try {
        const result = await widgets.create(request.auth.userId, request.params.channelId, request.body);
        switch (result.outcome) {
          case 'created': return reply.code(201).send(result.widget);
          case 'forbidden': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Channel not found', traceId: request.id });
          case 'tier_limit_reached': return reply.code(403).send({ schemaVersion: 'v1', errorCode: 'widget_limit_reached', message: "This tier's widget limit has been reached", traceId: request.id });
          case 'invalid': return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_widget_config', message: 'The widget could not be created', traceId: request.id });
        }
      } catch (error) {
        logSafeError(request, 'widget_config_create_failed', error);
        return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'interaction_store_unavailable', message: 'The widget could not be created', traceId: request.id, retryable: true });
      }
    },
  );

  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/widgets', { preHandler: auth, schema: { params: channelParams } }, async (request, reply) => {
    if (!widgets || !request.auth) return unavailable(reply, request.id);
    try {
      const items = await widgets.list(request.auth.userId, request.params.channelId);
      return reply.code(200).send({ schemaVersion: 'v1', items });
    } catch (error) {
      logSafeError(request, 'widget_config_list_failed', error);
      return unavailable(reply, request.id);
    }
  });

  app.patch<{ Params: { channelId: string; widgetConfigId: string }; Body: { placement?: Record<string, unknown>; style?: Record<string, unknown>; dataSource?: Record<string, unknown>; privacyScope?: 'private' | 'public'; isEnabled?: boolean } }>(
    '/v1/channels/:channelId/widgets/:widgetConfigId',
    { preHandler: termsAuth, schema: { params: widgetParams, body: updateWidgetBody } },
    async (request, reply) => {
      if (!widgets || !request.auth) return unavailable(reply, request.id);
      try {
        const result = await widgets.update(request.auth.userId, request.params.channelId, request.params.widgetConfigId, request.body);
        return sendWidgetMutate(reply, request.id, result);
      } catch (error) {
        logSafeError(request, 'widget_config_update_failed', error);
        return unavailable(reply, request.id);
      }
    },
  );

  app.delete<{ Params: { channelId: string; widgetConfigId: string } }>('/v1/channels/:channelId/widgets/:widgetConfigId', { preHandler: termsAuth, schema: { params: widgetParams } }, async (request, reply) => {
    if (!widgets || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await widgets.remove(request.auth.userId, request.params.channelId, request.params.widgetConfigId);
      return sendWidgetMutate(reply, request.id, result);
    } catch (error) {
      logSafeError(request, 'widget_config_delete_failed', error);
      return unavailable(reply, request.id);
    }
  });

  // --- leaderboard -------------------------------------------------------

  app.get<{ Params: { channelId: string }; Querystring: { window?: LeaderboardWindow } }>('/v1/channels/:channelId/leaderboard', { preHandler: auth, schema: { params: channelParams, querystring: leaderboardQuery } }, async (request, reply) => {
    if (!leaderboard || !request.auth) return unavailable(reply, request.id);
    try {
      const board = await leaderboard.get(request.auth.userId, request.params.channelId, request.query.window ?? 'all');
      return reply.code(200).send(board);
    } catch (error) {
      logSafeError(request, 'leaderboard_read_failed', error);
      return unavailable(reply, request.id);
    }
  });

  // --- overlay browser-source reads (bearer token, no session cookie) ------

  app.get<{ Params: { overlayId: string; widgetType: WidgetType }; Headers: { authorization?: string } }>(
    '/v1/overlay-widgets/:overlayId/config/:widgetType',
    { schema: { params: overlayWidgetTypeParams, headers: { type: 'object', properties: { authorization: { type: 'string', maxLength: 512 } } } } },
    async (request, reply) => {
      const token = bearerToken(request.headers.authorization);
      if (!token) return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'overlay_unauthorized', message: 'Widget is not available', traceId: request.id });
      if (!overlay) return overlayUnavailable(reply, request.id, 'Widget is temporarily unavailable');
      try {
        const config = await overlay.getWidgetConfig(token, request.params.overlayId, request.params.widgetType);
        return reply.code(200).send({ schemaVersion: 'v1', config: projectOverlayWidgetConfig(config) });
      } catch (error) {
        logSafeError(request, 'overlay_widget_config_read_failed', error);
        return overlayUnavailable(reply, request.id, 'Widget is temporarily unavailable');
      }
    },
  );

  app.get<{ Params: { overlayId: string; definitionId: string }; Headers: { authorization?: string } }>(
    '/v1/overlay-widgets/:overlayId/votes/:definitionId',
    { schema: { params: overlayDefinitionParams, headers: { type: 'object', properties: { authorization: { type: 'string', maxLength: 512 } } } } },
    async (request, reply) => {
      const token = bearerToken(request.headers.authorization);
      if (!token) return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'overlay_unauthorized', message: 'Vote widget is not available', traceId: request.id });
      if (!overlay) return overlayUnavailable(reply, request.id, 'Vote widget is temporarily unavailable');
      try {
        const tally = await overlay.getVoteTally(token, request.params.overlayId, request.params.definitionId);
        return reply.code(200).send({ schemaVersion: 'v1', tally: projectOverlayVoteTally(tally) });
      } catch (error) {
        logSafeError(request, 'overlay_vote_tally_read_failed', error);
        return overlayUnavailable(reply, request.id, 'Vote widget is temporarily unavailable');
      }
    },
  );

  app.get<{ Params: { overlayId: string; definitionId: string }; Headers: { authorization?: string } }>(
    '/v1/overlay-widgets/:overlayId/hype/:definitionId',
    { schema: { params: overlayDefinitionParams, headers: { type: 'object', properties: { authorization: { type: 'string', maxLength: 512 } } } } },
    async (request, reply) => {
      const token = bearerToken(request.headers.authorization);
      if (!token) return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'overlay_unauthorized', message: 'Hype widget is not available', traceId: request.id });
      if (!overlay) return overlayUnavailable(reply, request.id, 'Hype widget is temporarily unavailable');
      try {
        const state = await overlay.getHypeMode(token, request.params.overlayId, request.params.definitionId);
        return reply.code(200).send({ schemaVersion: 'v1', hype: projectOverlayHype(state) });
      } catch (error) {
        logSafeError(request, 'overlay_hype_state_read_failed', error);
        return overlayUnavailable(reply, request.id, 'Hype widget is temporarily unavailable');
      }
    },
  );

  app.get<{ Params: { overlayId: string }; Querystring: { window?: LeaderboardWindow }; Headers: { authorization?: string } }>(
    '/v1/overlay-widgets/:overlayId/leaderboard',
    { schema: { params: overlayParams, querystring: leaderboardQuery, headers: { type: 'object', properties: { authorization: { type: 'string', maxLength: 512 } } } } },
    async (request, reply) => {
      const token = bearerToken(request.headers.authorization);
      if (!token) return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'overlay_unauthorized', message: 'Leaderboard widget is not available', traceId: request.id });
      if (!overlay) return overlayUnavailable(reply, request.id, 'Leaderboard widget is temporarily unavailable');
      try {
        const board = await overlay.getLeaderboard(token, request.params.overlayId, request.query.window ?? 'all');
        return reply.code(200).send({ schemaVersion: 'v1', leaderboard: projectOverlayLeaderboard(board) });
      } catch (error) {
        logSafeError(request, 'overlay_leaderboard_read_failed', error);
        return overlayUnavailable(reply, request.id, 'Leaderboard widget is temporarily unavailable');
      }
    },
  );

  // --- L16 gap closure (0108): paid-vote overlay + the four widgets that
  // had config but no rendered OBS page (recent_tips, top_supporters,
  // supporter_ticker, mega_tip_banner). Same bearer-token-in-fragment ->
  // Authorization-header -> sha256-fingerprint-against-overlay_sessions
  // model as every route above; no second auth path. --------------------

  app.get<{ Params: { overlayId: string; definitionId: string }; Headers: { authorization?: string } }>(
    '/v1/overlay-widgets/:overlayId/paid-votes/:definitionId',
    { schema: { params: overlayDefinitionParams, headers: { type: 'object', properties: { authorization: { type: 'string', maxLength: 512 } } } } },
    async (request, reply) => {
      const token = bearerToken(request.headers.authorization);
      if (!token) return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'overlay_unauthorized', message: 'Paid vote widget is not available', traceId: request.id });
      if (!paidVoteOverlay) return overlayUnavailable(reply, request.id, 'Paid vote widget is temporarily unavailable');
      try {
        const tally = await paidVoteOverlay.getPaidVoteTally(token, request.params.overlayId, request.params.definitionId);
        return reply.code(200).send({ schemaVersion: 'v1', tally: projectOverlayPaidVoteTally(tally) });
      } catch (error) {
        logSafeError(request, 'overlay_paid_vote_tally_read_failed', error);
        return overlayUnavailable(reply, request.id, 'Paid vote widget is temporarily unavailable');
      }
    },
  );

  app.get<{ Params: { overlayId: string }; Headers: { authorization?: string } }>(
    '/v1/overlay-widgets/:overlayId/recent-tips',
    { schema: { params: overlayParams, headers: { type: 'object', properties: { authorization: { type: 'string', maxLength: 512 } } } } },
    async (request, reply) => {
      const token = bearerToken(request.headers.authorization);
      if (!token) return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'overlay_unauthorized', message: 'Recent tips widget is not available', traceId: request.id });
      if (!widgetOverlaySql) return overlayUnavailable(reply, request.id, 'Recent tips widget is temporarily unavailable');
      try {
        const rows = await widgetOverlaySql<{ display_name: string; amount_paise: string | number; message: string | null; created_at: Date }[]>`
          select display_name, amount_paise, message, created_at
            from app_private.list_overlay_recent_tips(${request.params.overlayId}::uuid, ${widgetFingerprint(token)})
        `;
        const tips = rows.map((row) => ({ displayName: row.display_name, amountPaise: Number(row.amount_paise), message: row.message, createdAt: row.created_at.toISOString() }));
        return reply.code(200).send({ schemaVersion: 'v1', tips });
      } catch (error) {
        logSafeError(request, 'overlay_recent_tips_read_failed', error);
        return overlayUnavailable(reply, request.id, 'Recent tips widget is temporarily unavailable');
      }
    },
  );

  app.get<{ Params: { overlayId: string }; Headers: { authorization?: string } }>(
    '/v1/overlay-widgets/:overlayId/top-supporters',
    { schema: { params: overlayParams, headers: { type: 'object', properties: { authorization: { type: 'string', maxLength: 512 } } } } },
    async (request, reply) => {
      const token = bearerToken(request.headers.authorization);
      if (!token) return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'overlay_unauthorized', message: 'Top supporters widget is not available', traceId: request.id });
      if (!widgetOverlaySql) return overlayUnavailable(reply, request.id, 'Top supporters widget is temporarily unavailable');
      try {
        const rows = await widgetOverlaySql<{ rank: number; viewer_ref: string; tier_label: string }[]>`
          select rank, viewer_ref, tier_label
            from app_private.list_overlay_top_supporters(${request.params.overlayId}::uuid, ${widgetFingerprint(token)})
        `;
        const supporters = rows.map((row) => ({ rank: row.rank, viewerRef: row.viewer_ref, tierLabel: row.tier_label }));
        return reply.code(200).send({ schemaVersion: 'v1', supporters });
      } catch (error) {
        logSafeError(request, 'overlay_top_supporters_read_failed', error);
        return overlayUnavailable(reply, request.id, 'Top supporters widget is temporarily unavailable');
      }
    },
  );

  app.get<{ Params: { overlayId: string }; Headers: { authorization?: string } }>(
    '/v1/overlay-widgets/:overlayId/supporter-ticker',
    { schema: { params: overlayParams, headers: { type: 'object', properties: { authorization: { type: 'string', maxLength: 512 } } } } },
    async (request, reply) => {
      const token = bearerToken(request.headers.authorization);
      if (!token) return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'overlay_unauthorized', message: 'Supporter ticker widget is not available', traceId: request.id });
      if (!widgetOverlaySql) return overlayUnavailable(reply, request.id, 'Supporter ticker widget is temporarily unavailable');
      try {
        const rows = await widgetOverlaySql<{ viewer_ref: string; tier_label: string; supported_at: Date }[]>`
          select viewer_ref, tier_label, supported_at
            from app_private.list_overlay_supporter_ticker(${request.params.overlayId}::uuid, ${widgetFingerprint(token)})
        `;
        const entries = rows.map((row) => ({ viewerRef: row.viewer_ref, tierLabel: row.tier_label, supportedAt: row.supported_at.toISOString() }));
        return reply.code(200).send({ schemaVersion: 'v1', entries });
      } catch (error) {
        logSafeError(request, 'overlay_supporter_ticker_read_failed', error);
        return overlayUnavailable(reply, request.id, 'Supporter ticker widget is temporarily unavailable');
      }
    },
  );

  app.get<{ Params: { overlayId: string }; Headers: { authorization?: string } }>(
    '/v1/overlay-widgets/:overlayId/mega-tip-banner',
    { schema: { params: overlayParams, headers: { type: 'object', properties: { authorization: { type: 'string', maxLength: 512 } } } } },
    async (request, reply) => {
      const token = bearerToken(request.headers.authorization);
      if (!token) return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'overlay_unauthorized', message: 'Mega tip banner widget is not available', traceId: request.id });
      if (!widgetOverlaySql) return overlayUnavailable(reply, request.id, 'Mega tip banner widget is temporarily unavailable');
      try {
        const rows = await widgetOverlaySql<{ display_name: string; amount_paise: string | number; created_at: Date }[]>`
          select display_name, amount_paise, created_at
            from app_private.list_overlay_mega_tip_banner(${request.params.overlayId}::uuid, ${widgetFingerprint(token)})
        `;
        const row = rows[0];
        const banner = row ? { displayName: row.display_name, amountPaise: Number(row.amount_paise), createdAt: row.created_at.toISOString() } : null;
        return reply.code(200).send({ schemaVersion: 'v1', banner });
      } catch (error) {
        logSafeError(request, 'overlay_mega_tip_banner_read_failed', error);
        return overlayUnavailable(reply, request.id, 'Mega tip banner widget is temporarily unavailable');
      }
    },
  );
}

// Same sha256-fingerprint-of-the-bearer-token scheme every overlay read in
// this codebase uses (db/interaction-sql-store.ts, db/goal-overlay-store.ts)
// — matched against overlay_sessions.token_fingerprint inside each
// SECURITY DEFINER function. No new auth path.
function widgetFingerprint(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function sendLifecycleResult(reply: ReplyLike, traceId: string, result: { outcome: 'ok' } | { outcome: 'forbidden' | 'not_found' | 'invalid' }) {
  switch (result.outcome) {
    case 'ok': return reply.code(200).send({ schemaVersion: 'v1', ok: true });
    case 'forbidden': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Interaction definition not found', traceId });
    case 'not_found': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Interaction definition not found', traceId });
    case 'invalid': return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_hype_mode', message: 'This hype mode action could not be completed', traceId });
  }
}

function sendWidgetMutate(reply: ReplyLike, traceId: string, result: { outcome: 'ok'; widget?: unknown } | { outcome: 'forbidden' | 'not_found' | 'invalid' }) {
  switch (result.outcome) {
    case 'ok': return reply.code(200).send(result.widget ?? { schemaVersion: 'v1', ok: true });
    case 'forbidden': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Widget config not found', traceId });
    case 'not_found': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Widget config not found', traceId });
    case 'invalid': return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_widget_config', message: 'The widget could not be updated', traceId });
  }
}
