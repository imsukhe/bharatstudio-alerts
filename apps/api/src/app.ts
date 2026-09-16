import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { RuntimeConfig } from './config.js';
import type { PublicChannelRepository } from './domain/public-channel.js';
import { registerPublicRoutes } from './routes/public.js';
import type { GoogleIdentityVerifier } from './auth/google.js';
import type { SessionStore } from './auth/session-store.js';
import { installAuthState } from './auth/pre-handler.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerMeRoutes } from './routes/me.js';
import type { ChannelStore } from './domain/channel-store.js';
import { registerChannelRoutes } from './routes/channels.js';
import type { AlertStore } from './domain/alert-store.js';
import { registerAlertRoutes } from './routes/alerts.js';
import { registerCompanionRoutes } from './routes/companion.js';
import type { CompanionPairingStore } from './domain/companion-pairing.js';
import { registerCompanionPairingRoutes } from './routes/companion-pairing.js';
import type { OverlayStore } from './domain/overlay-store.js';
import { registerOverlayRoutes } from './routes/overlay.js';
import type { OverlayWakeup } from './domain/overlay-wakeup.js';
import type { PaymentOrderService } from './domain/payment-order.js';
import type { PaymentSubscriptionService } from './domain/payment-subscription.js';
import type { PublicPaymentStatusRepository } from './domain/public-payment-status.js';
import type { MaintenanceStore, ServiceIdentityVerifier } from './domain/maintenance.js';
import type { NotificationStore } from './domain/notification-store.js';
import type { NotificationTokenProtector } from './notifications/token-crypto.js';
import type { PaymentAccountStore } from './domain/payment-account.js';
import { registerPaymentAccountRoutes } from './routes/payment-accounts.js';
import type { PaymentLedgerStore } from './domain/payment-ledger.js';
import { registerPaymentLedgerRoutes } from './routes/payments.js';
import type { AdminStore } from './domain/admin.js';
import { registerAdminRoutes } from './routes/admin.js';
import type { EmailOutboxStore, EmailSender } from './domain/email.js';
import { drainEmailOutbox } from './email/dispatch.js';
import type { AccountStore } from './domain/account-store.js';
import { registerAccountRoutes } from './routes/account.js';
import { registerMaintenanceRoutes } from './routes/maintenance.js';
import { createApiMetrics, type ApiMetrics } from './observability/metrics.js';
import { logSafeError } from './observability/safe-log.js';
import { classifyReadPriority } from './domain/read-priority.js';
import { createReadBackpressureGovernor, type ReadBackpressureGovernor } from './domain/read-backpressure.js';
import { channelConfigSchema } from './domain/channel-config-schema.js';
import type { PublicAbuseGuard } from './domain/public-abuse.js';
import type { TtsService } from './tts/provider.js';
import type { TtsStore } from './domain/tts-store.js';
import type { TtsQuotaMeter } from './domain/tts-quota.js';
import type { ViewerStore } from './domain/viewer-store.js';
import type { ViewerPlatformIdentityVerifier } from './domain/viewer-platform-identity-verifier.js';
import { registerViewerRoutes } from './routes/viewer.js';
import type { YoutubeConnectionStore } from './domain/youtube-connection.js';
import type { YoutubeOAuthClient } from './domain/youtube-oauth-client.js';
import type { PaymentMethodUpdateService } from './domain/billing-payment-method.js';
import type { CompanionFeatureStore } from './domain/companion-feature-store.js';
import type { CompanionEntitlementStore } from './domain/companion-entitlement-policy.js';
import type { GoalStore, OverlayGoalStore } from './domain/goal-store.js';
import type { SeatStore } from './domain/seat-store.js';
import type { HypeModeStore, InteractionDefinitionStore, InteractionOverlayStore, LeaderboardStore, PublicVoteStore, SupportVoteStore, WidgetConfigStore } from './domain/interaction-types.js';
import { registerInteractionRoutes } from './routes/interactions.js';
import type { PaidSupportVoteStore, PaidVoteOverlayStore, PublicPaidVoteStore, TugOfWarVoteOverlayStore, VotePaymentTagStore } from './domain/vote-payment-types.js';
import type { TemplateCatalogueStore } from './domain/template-catalogue.js';
import { registerTemplateRoutes } from './routes/templates.js';
import type { StickerCatalogueStore, PublicStickerCatalogueStore, StickerSelectionStore } from './domain/sticker-catalogue.js';
import type { CreatorPackStore, PublicCreatorPackStore, CreatorPackSelectionStore } from './domain/sticker-creator-pack.js';
import { registerStickerRoutes } from './routes/stickers.js';
import type { ChallengeStore, OverlayChallengeStore } from './domain/challenge-store.js';
import { registerChallengeRoutes } from './routes/challenges.js';
import type { ReputationStore } from './domain/reputation-store.js';
import type { ProviderCapabilitySnapshotStore } from './domain/payment-provider-creator.js';
import { registerReputationRoutes } from './routes/reputation.js';
import { registerGoalRoutes } from './routes/goals.js';
import type { MasterCanvasOverlayStore, MasterCanvasStore } from './domain/master-canvas-store.js';
import { registerMasterCanvasRoutes } from './routes/master-canvas.js';
import type { IngestFailureAdminStore } from './domain/ingest-failure-admin.js';
import type { StaffCreatorPackReviewStore } from './domain/staff-creator-pack-review.js';
import type { Sql } from 'postgres';
import { registerMetricsRoutes } from './routes/metrics.js';
import { registerYoutubeRoutes } from './routes/youtube.js';
import type { OverlayAudioStore } from './domain/overlay-audio-store.js';
import { registerTtsRoutes } from './routes/tts.js';
import { registerOverlayAudioRoutes } from './routes/overlay-audio.js';
import type { ReferralStore } from './domain/referrals.js';
import { registerReferralRoutes } from './routes/referrals.js';
import type { BrandingStore, OverlayBrandingStore } from './domain/branding.js';
import { registerBrandingRoutes } from './routes/branding.js';
import { registerOverlayLottieRoutes } from './routes/overlay-lottie.js';
import type { AssistStore } from './domain/assist-types.js';
import { registerAssistRoutes } from './routes/assist.js';

export type AppDependencies = {
  publicChannels?: PublicChannelRepository;
  google?: GoogleIdentityVerifier;
  sessions?: SessionStore;
  channels?: ChannelStore;
  alerts?: AlertStore;
  overlays?: OverlayStore;
  overlayWakeup?: OverlayWakeup;
  overlayNow?: () => number;
  overlayRandom?: () => number;
  overlaySleep?: (timeoutMs: number, signal: AbortSignal) => Promise<void>;
  paymentOrders?: PaymentOrderService;
  paymentSubscriptions?: PaymentSubscriptionService;
  publicPaymentStatus?: PublicPaymentStatusRepository;
  maintenance?: MaintenanceStore;
  serviceIdentity?: ServiceIdentityVerifier;
  metrics?: ApiMetrics;
  // RT-10. Overridable for tests; defaults to one built from `config`
  // (`derivedReadMaxConcurrent`, unset by default — see read-backpressure.ts).
  readBackpressureGovernor?: ReadBackpressureGovernor;
  readiness?: () => Promise<boolean>;
  notifications?: NotificationStore;
  notificationTokenProtector?: NotificationTokenProtector;
  paymentAccounts?: PaymentAccountStore;
  paymentLedger?: PaymentLedgerStore;
  admin?: AdminStore;
  emailOutbox?: EmailOutboxStore;
  emailSender?: EmailSender;
  account?: AccountStore;
  publicAbuseGuard?: PublicAbuseGuard;
  tts?: TtsService;
  ttsStore?: TtsStore;
  ttsQuotaMeter?: TtsQuotaMeter;
  viewer?: ViewerStore;
  platformIdentityVerifier?: ViewerPlatformIdentityVerifier;
  youtubeConnections?: YoutubeConnectionStore;
  youtubeOAuthClient?: YoutubeOAuthClient;
  paymentMethodUpdates?: PaymentMethodUpdateService;
  companionFeatures?: CompanionFeatureStore;
  companionEntitlement?: CompanionEntitlementStore;
  seats?: SeatStore;
  goals?: GoalStore;
  overlayGoals?: OverlayGoalStore;
  masterCanvasModules?: MasterCanvasStore;
  overlayMasterCanvasModules?: MasterCanvasOverlayStore;
  reputation?: ReputationStore;
  capabilitySnapshots?: ProviderCapabilitySnapshotStore;
  challenges?: ChallengeStore;
  overlayChallenges?: OverlayChallengeStore;
  interactionDefinitions?: InteractionDefinitionStore;
  interactionVotes?: SupportVoteStore;
  interactionPublicVotes?: PublicVoteStore;
  interactionHype?: HypeModeStore;
  interactionWidgets?: WidgetConfigStore;
  interactionLeaderboard?: LeaderboardStore;
  interactionOverlay?: InteractionOverlayStore;
  votePaymentTags?: VotePaymentTagStore;
  publicPaidVotes?: PublicPaidVoteStore;
  paidVotes?: PaidSupportVoteStore;
  paidVoteOverlay?: PaidVoteOverlayStore;
  // PRF-02 slice 2, module #3 (Tug-of-War Vote).
  tugOfWarVoteOverlay?: TugOfWarVoteOverlayStore;
  templates?: TemplateCatalogueStore;
  stickers?: StickerCatalogueStore;
  publicStickers?: PublicStickerCatalogueStore;
  stickerSelections?: StickerSelectionStore;
  creatorPack?: CreatorPackStore;
  publicCreatorPack?: PublicCreatorPackStore;
  creatorPackSelections?: CreatorPackSelectionStore;
  ingestFailures?: IngestFailureAdminStore;
  staffCreatorPackReview?: StaffCreatorPackReviewStore;
  // L09 reconciliation queries read across payments/refunds/outbox, so the
  // metrics route needs the raw client rather than a narrow store.
  sql?: Sql;
  // RT-10/RT-11. The `Sql` handle used for widget/dashboard/analytics reads
  // (`db/derived-read-pool.ts`'s `createDerivedReadSql`). Defaults to `sql`
  // when not given, so an omitted value is the RT-10/RT-11 kill switch —
  // identical behaviour to today, on the same pool, with no timeout.
  derivedReadSql?: Sql;
  overlayAudio?: OverlayAudioStore;
  referrals?: ReferralStore;
  branding?: BrandingStore;
  overlayBranding?: OverlayBrandingStore;
  companionPairing?: CompanionPairingStore;
  assist?: AssistStore;
};

export async function buildApp(
  config: RuntimeConfig,
  dependencies: AppDependencies = {},
): Promise<FastifyInstance> {
  if ((config.nodeEnv === 'staging' || config.nodeEnv === 'production') && !dependencies.account) {
    throw new Error('Account store is required in staging and production for terms and privacy enforcement');
  }
  const app = Fastify({
    // Reject, rather than silently strip, unknown creator-controlled fields.
    // Silent removal would make a client believe a configuration was saved
    // when the server actually discarded part of it.
    ajv: { customOptions: { removeAdditional: false } },
    bodyLimit: 64 * 1024,
    ...(config.nodeEnv === 'test'
      ? { logger: false }
      : { logger: { redact: ['req.headers.authorization', 'req.headers.cookie', 'req.url', 'req.raw.url'] } }),
  });
  const metrics = dependencies.metrics ?? createApiMetrics();
  const readBackpressureGovernor = dependencies.readBackpressureGovernor
    ?? createReadBackpressureGovernor(
      { maxConcurrentDerivedReads: config.derivedReadMaxConcurrent },
      (outcome) => metrics.recordDerivedReadAdmission(outcome),
    );
  app.addSchema(channelConfigSchema);

  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  });
  await app.register(cors, {
    origin: (requestOrigin, callback) => {
      // Browsers omit Origin for same-origin/non-CORS requests. For an
      // explicit origin, emit credentialed CORS headers only for the one
      // configured web application origin; never reflect arbitrary input.
      callback(null, !requestOrigin || requestOrigin === config.appOrigin);
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  await app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
    allowList: config.nodeEnv === 'test' ? ['127.0.0.1'] : [],
  });

  // RT-10 (§19.0, §31.18.0): admission control for widget/dashboard/analytics
  // reads, first in the chain so a shed request is rejected before auth
  // state, body parsing or any handler work runs. `classifyReadPriority`
  // (domain/read-priority.ts) is the single chokepoint RT-10 and RT-11
  // share; a request outside the `derived_read` class (every write, every
  // exempt durable-path read) is untouched here — admission is a no-op, not
  // merely "usually admitted" (RT-10.4). Released in `onResponse` below,
  // via a WeakMap keyed by request rather than mutating the request object.
  const derivedReadReleases = new WeakMap<object, () => void>();
  app.addHook('onRequest', async (request, reply) => {
    const route = request.routeOptions.url ?? 'unknown';
    if (classifyReadPriority(request.method, route) !== 'derived_read') return;
    const admission = readBackpressureGovernor.tryAdmit();
    if (!admission.admitted) {
      reply.header('retry-after', '1');
      return reply.code(503).send({
        schemaVersion: 'v1',
        errorCode: 'derived_read_shed',
        message: 'Too many widget, dashboard or analytics reads in flight. Retry shortly.',
        traceId: request.id,
        retryable: true,
      });
    }
    derivedReadReleases.set(request, admission.release);
  });
  app.addHook('onRequest', async (request) => installAuthState(request));
  app.addHook('onResponse', async (request, reply) => {
    derivedReadReleases.get(request)?.();
    metrics.observe(request.method, request.routeOptions.url ?? 'unknown', reply.statusCode, reply.elapsedTime);
  });

  app.setErrorHandler(async (error, request, reply) => {
    const fastifyError = error as FastifyError;
    if (fastifyError.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.code(413).send({
        schemaVersion: 'v1',
        errorCode: 'request_too_large',
        message: 'Request is too large',
        traceId: request.id,
        retryable: false,
      });
    }
    if (fastifyError.code === 'FST_ERR_CTP_INVALID_JSON_BODY') {
      return reply.code(400).send({
        schemaVersion: 'v1',
        errorCode: 'bad_request',
        message: 'Request body is invalid JSON',
        traceId: request.id,
        retryable: false,
      });
    }
    if (fastifyError.statusCode === 429) {
      return reply.code(429).send({
        schemaVersion: 'v1',
        errorCode: 'rate_limited',
        message: 'Too many requests',
        traceId: request.id,
        retryable: true,
      });
    }
    if (fastifyError.validation) {
      return reply.code(400).send({
        schemaVersion: 'v1',
        errorCode: 'bad_request',
        message: 'Request validation failed',
        traceId: request.id,
      });
    }

    logSafeError(request, 'unhandled_api_error', fastifyError);
    return reply.code(500).send({
      schemaVersion: 'v1',
      errorCode: 'internal_error',
      message: 'An unexpected error occurred',
      traceId: request.id,
      retryable: true,
    });
  });

  await registerPublicRoutes(
    app,
    dependencies.publicChannels,
    dependencies.paymentOrders,
    config.paymentEnvironment ?? (config.nodeEnv === 'production' ? 'live' : 'test'),
    dependencies.publicPaymentStatus,
    dependencies.publicAbuseGuard,
    config.publicPaymentTurnstileRequired === true,
    undefined,
    undefined,
    config.appOrigin,
    dependencies.votePaymentTags,
    dependencies.publicPaidVotes,
  );
  await registerAuthRoutes(app, dependencies);
  await registerMeRoutes(app, dependencies.sessions, dependencies.notifications, dependencies.notificationTokenProtector, dependencies.account);
  await registerAccountRoutes(app, dependencies.sessions, dependencies.account, dependencies.emailOutbox);
  await registerChannelRoutes(app, dependencies.sessions, dependencies.channels, dependencies.account, dependencies.referrals, dependencies.seats);
  await registerPaymentAccountRoutes(app, dependencies.sessions, dependencies.paymentAccounts, dependencies.account, undefined, dependencies.capabilitySnapshots);
  await registerPaymentLedgerRoutes(app, dependencies.sessions, dependencies.paymentLedger);
  await registerReferralRoutes(app, dependencies.sessions, dependencies.referrals);
  await registerBrandingRoutes(app, dependencies.sessions, dependencies.branding, dependencies.account);
  await registerAdminRoutes(app, dependencies.sessions, dependencies.admin, dependencies.ingestFailures, dependencies.staffCreatorPackReview);
  await registerAlertRoutes(app, dependencies.sessions, dependencies.alerts, dependencies.paymentSubscriptions, config.paymentEnvironment ?? (config.nodeEnv === 'production' ? 'live' : 'test'), dependencies.account, dependencies.paymentMethodUpdates);
  await registerCompanionRoutes(app, dependencies.sessions, dependencies.alerts, dependencies.account, dependencies.companionFeatures, dependencies.companionEntitlement);
  await registerCompanionPairingRoutes(app, dependencies.sessions, dependencies.companionPairing);
  await registerAssistRoutes(app, dependencies.sessions, dependencies.assist, dependencies.account);
  await registerMaintenanceRoutes(app, dependencies.maintenance, dependencies.serviceIdentity);
  await registerTtsRoutes(app, dependencies.serviceIdentity, dependencies.ttsStore, dependencies.tts, dependencies.ttsQuotaMeter, metrics);
  await registerViewerRoutes(app, { viewer: dependencies.viewer, platformIdentityVerifier: dependencies.platformIdentityVerifier });
  await registerGoalRoutes(app, dependencies.sessions, dependencies.goals, dependencies.account, dependencies.overlayGoals);
  await registerMasterCanvasRoutes(app, dependencies.sessions, dependencies.masterCanvasModules, dependencies.account, dependencies.overlayMasterCanvasModules);
  await registerReputationRoutes(app, dependencies.sessions, dependencies.reputation);
  await registerChallengeRoutes(app, dependencies.sessions, dependencies.challenges, dependencies.account, dependencies.overlayChallenges);
  await registerTemplateRoutes(app, dependencies.sessions, dependencies.templates);
  await registerStickerRoutes(app, dependencies.sessions, dependencies.stickers, dependencies.account, dependencies.publicStickers, dependencies.stickerSelections, dependencies.creatorPack, dependencies.publicCreatorPack, dependencies.creatorPackSelections);
  await registerInteractionRoutes(app, dependencies.sessions, dependencies.account, dependencies.interactionDefinitions, dependencies.interactionVotes, dependencies.interactionPublicVotes, dependencies.interactionHype, dependencies.interactionWidgets, dependencies.interactionLeaderboard, dependencies.interactionOverlay, dependencies.paidVotes, dependencies.paidVoteOverlay, dependencies.derivedReadSql ?? dependencies.sql, undefined, dependencies.tugOfWarVoteOverlay);
  await registerYoutubeRoutes(app, dependencies.sessions, dependencies.youtubeConnections, dependencies.account, dependencies.youtubeOAuthClient);
  await registerOverlayAudioRoutes(app, dependencies.overlayAudio);
  await registerOverlayLottieRoutes(app, dependencies.overlayBranding);
  await registerOverlayRoutes(
    app,
    dependencies.sessions,
    dependencies.overlays,
    dependencies.overlayWakeup,
    {
      windowMs: config.overlayStreamWindowMs ?? (config.nodeEnv === 'test' ? 0 : 25_000),
      pollMs: config.overlayPollMs ?? 2_000,
      now: dependencies.overlayNow,
      random: dependencies.overlayRandom,
      sleep: dependencies.overlaySleep,
    },
    dependencies.account,
    config.appOrigin,
    metrics,
  );

  app.addHook('onClose', async () => {
    await dependencies.overlayWakeup?.close();
  });

  app.get('/healthz', async () => ({ status: 'ok', service: 'bharatstudio-alerts-api' }));

  app.get('/readyz', async (_request, reply) => {
    if (!dependencies.readiness) {
      return reply.code(503).send({ status: 'not_ready', reason: 'runtime_adapters_not_configured' });
    }
    try {
      if (!await dependencies.readiness()) {
        return reply.code(503).send({ status: 'not_ready', reason: 'runtime_dependency_unavailable' });
      }
      return reply.code(200).send({ status: 'ready' });
    } catch {
      return reply.code(503).send({ status: 'not_ready', reason: 'runtime_dependency_unavailable' });
    }
  });

  // Metrics + reliability reconciliation now live in routes/metrics.ts (L09).
  // The previous inline handler is replaced wholesale rather than kept
  // alongside — two handlers on the same path would be a duplicate route.
  await registerMetricsRoutes(app, {
    metrics,
    serviceIdentity: dependencies.serviceIdentity,
    sql: dependencies.sql,
    overlayWakeupHealth: () => dependencies.overlayWakeup?.health?.(),
  });

  // Internal drain for the email outbox (invoice/subscription events, DPDP
  // export delivery, overlay-expiry reminders — see packages/db/migrations/
  // 0075_v1_l02_l03_l04_email_delivery.sql). Service-identity gated, same
  // boundary as /internal/metrics and /internal/maintenance/:job. Manual/
  // internal invocation is the interim trigger; a schedule entry stays
  // disabled per the non-negotiable invariant until private targets/IAM/
  // monitoring/retries/staging evidence are recorded.
  app.post<{ Body: { limit?: number } }>('/internal/email-outbox/drain', {
    schema: { body: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } } } },
  }, async (request, reply) => {
    if (!dependencies.serviceIdentity || !await dependencies.serviceIdentity.verify(request.headers.authorization)) {
      return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'unauthorized', message: 'Internal service authorization required', traceId: request.id });
    }
    if (!dependencies.emailOutbox) {
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'email_outbox_unavailable', message: 'Email outbox is not configured', traceId: request.id, retryable: true });
    }
    try {
      const summary = await drainEmailOutbox(dependencies.emailOutbox, dependencies.emailSender, request.body?.limit ?? 25);
      return reply.code(200).send({ schemaVersion: 'v1', ...summary });
    } catch (error) {
      logSafeError(request, 'email_outbox_drain_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'email_outbox_unavailable', message: 'Email outbox drain could not be completed', traceId: request.id, retryable: true });
    }
  });

  app.setNotFoundHandler(async (request, reply) => {
    return reply.code(404).send({
      schemaVersion: 'v1',
      errorCode: 'not_found',
      message: 'Route is not available',
      traceId: request.id,
    });
  });

  return app;
}
