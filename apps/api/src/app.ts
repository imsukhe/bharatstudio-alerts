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
import { channelConfigSchema } from './domain/channel-config-schema.js';
import type { PublicAbuseGuard } from './domain/public-abuse.js';
import type { TtsService } from './tts/provider.js';
import type { TtsStore } from './domain/tts-store.js';
import type { OverlayAudioStore } from './domain/overlay-audio-store.js';
import { registerTtsRoutes } from './routes/tts.js';
import { registerOverlayAudioRoutes } from './routes/overlay-audio.js';
import type { ReferralStore } from './domain/referrals.js';
import { registerReferralRoutes } from './routes/referrals.js';

export type AppDependencies = {
  publicChannels?: PublicChannelRepository;
  google?: GoogleIdentityVerifier;
  sessions?: SessionStore;
  channels?: ChannelStore;
  alerts?: AlertStore;
  overlays?: OverlayStore;
  overlayWakeup?: OverlayWakeup;
  paymentOrders?: PaymentOrderService;
  paymentSubscriptions?: PaymentSubscriptionService;
  publicPaymentStatus?: PublicPaymentStatusRepository;
  maintenance?: MaintenanceStore;
  serviceIdentity?: ServiceIdentityVerifier;
  metrics?: ApiMetrics;
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
  overlayAudio?: OverlayAudioStore;
  referrals?: ReferralStore;
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

  app.addHook('onRequest', async (request) => installAuthState(request));
  app.addHook('onResponse', async (request, reply) => {
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
  );
  await registerAuthRoutes(app, dependencies);
  await registerMeRoutes(app, dependencies.sessions, dependencies.notifications, dependencies.notificationTokenProtector, dependencies.account);
  await registerAccountRoutes(app, dependencies.sessions, dependencies.account, dependencies.emailOutbox);
  await registerChannelRoutes(app, dependencies.sessions, dependencies.channels, dependencies.account, dependencies.referrals);
  await registerPaymentAccountRoutes(app, dependencies.sessions, dependencies.paymentAccounts, dependencies.account);
  await registerPaymentLedgerRoutes(app, dependencies.sessions, dependencies.paymentLedger);
  await registerReferralRoutes(app, dependencies.sessions, dependencies.referrals);
  await registerAdminRoutes(app, dependencies.sessions, dependencies.admin);
  await registerAlertRoutes(app, dependencies.sessions, dependencies.alerts, dependencies.paymentSubscriptions, config.paymentEnvironment ?? (config.nodeEnv === 'production' ? 'live' : 'test'), dependencies.account);
  await registerCompanionRoutes(app, dependencies.sessions, dependencies.alerts, dependencies.account);
  await registerMaintenanceRoutes(app, dependencies.maintenance, dependencies.serviceIdentity);
  await registerTtsRoutes(app, dependencies.serviceIdentity, dependencies.ttsStore, dependencies.tts);
  await registerOverlayAudioRoutes(app, dependencies.overlayAudio);
  await registerOverlayRoutes(
    app,
    dependencies.sessions,
    dependencies.overlays,
    dependencies.overlayWakeup,
    {
      windowMs: config.overlayStreamWindowMs ?? (config.nodeEnv === 'test' ? 0 : 25_000),
      pollMs: config.overlayPollMs ?? 2_000,
    },
    dependencies.account,
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

  app.get('/internal/metrics', async (request, reply) => {
    if (!dependencies.serviceIdentity || !await dependencies.serviceIdentity.verify(request.headers.authorization)) {
      return reply.code(401).type('text/plain; version=0.0.4').send('unauthorized\n');
    }
    let output = metrics.renderPrometheus();
    const wakeupHealth = dependencies.overlayWakeup?.health?.();
    if (wakeupHealth) {
      output += '# HELP bsa_overlay_listener_connected Whether the direct overlay listener is connected.\n';
      output += '# TYPE bsa_overlay_listener_connected gauge\n';
      output += `bsa_overlay_listener_connected ${wakeupHealth.connected ? 1 : 0}\n`;
      output += '# HELP bsa_overlay_listener_reconnects_total Overlay listener reconnect attempts.\n';
      output += '# TYPE bsa_overlay_listener_reconnects_total counter\n';
      output += `bsa_overlay_listener_reconnects_total ${wakeupHealth.reconnects}\n`;
      output += '# HELP bsa_overlay_listener_failures_total Overlay listener connection failures.\n';
      output += '# TYPE bsa_overlay_listener_failures_total counter\n';
      output += `bsa_overlay_listener_failures_total ${wakeupHealth.failures}\n`;
    }
    return reply.type('text/plain; version=0.0.4').send(output);
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
