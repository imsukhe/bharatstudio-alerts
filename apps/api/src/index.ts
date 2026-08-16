import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPublicChannelRepository, createSqlClient } from './db/public-channel-repository.js';
import { createPublicPaymentStatusRepository } from './db/public-payment-status-repository.js';
import { createGoogleIdentityVerifier } from './auth/google.js';
import { createSqlSessionStore } from './auth/session-store.js';
import { createSqlChannelStore } from './db/channel-store.js';
import { createSqlAlertStore } from './db/alert-store.js';
import { createSqlOverlayStore } from './db/overlay-store.js';
import { createDirectOverlayWakeup } from './db/overlay-wakeup.js';
import { createGooglePaymentOrderService } from './db/payment-order-client.js';
import { createGooglePaymentSubscriptionService } from './db/payment-subscription-client.js';
import { createGoogleServiceIdentityVerifier } from './auth/service-identity.js';
import { createSqlMaintenanceStore } from './db/maintenance-store.js';
import { createSqlReadiness } from './db/readiness.js';
import { createSqlNotificationStore } from './db/notification-store.js';
import { createNotificationTokenProtector } from './notifications/token-crypto.js';
import { createSqlPaymentAccountStore } from './db/payment-account-store.js';
import { createSqlPaymentLedgerStore } from './db/payment-ledger.js';
import { createSqlAdminStore } from './db/admin-store.js';
import { createSqlEmailOutboxStore } from './db/email-store.js';
import { createResendEmailSender } from './email/resend-sender.js';
import { createSqlAccountStore } from './db/account-store.js';
import { createTurnstileGuard } from './domain/public-abuse.js';
import { createSqlTtsStore } from './db/tts-store.js';
import { createSqlOverlayAudioStore } from './db/overlay-audio-store.js';
import { createSqlTtsCache } from './db/tts-cache.js';
import { createSarvamTtsProvider, createTtsService } from './tts/provider.js';

const config = loadConfig();
const sql = config.databaseUrlApp ? createSqlClient(config.databaseUrlApp) : undefined;
const paymentOrders = config.paymentServiceOrigin && config.paymentServiceAudience
  ? createGooglePaymentOrderService(config.paymentServiceOrigin, config.paymentServiceAudience, config.nodeEnv)
  : undefined;
const paymentSubscriptions = config.paymentServiceOrigin && config.paymentServiceAudience
  ? createGooglePaymentSubscriptionService(config.paymentServiceOrigin, config.paymentServiceAudience, config.nodeEnv)
  : undefined;
const serviceIdentity = config.internalServiceAudiences?.length
  ? createGoogleServiceIdentityVerifier(config.internalServiceAudiences)
  : undefined;
const app = await buildApp(config, {
  publicChannels: sql ? createPublicChannelRepository(sql) : undefined,
  google: config.googleClientId ? createGoogleIdentityVerifier(config.googleClientId) : undefined,
  sessions: sql ? createSqlSessionStore(sql) : undefined,
  channels: sql ? createSqlChannelStore(sql) : undefined,
  alerts: sql ? createSqlAlertStore(sql) : undefined,
  overlays: sql ? createSqlOverlayStore(sql, config.appOrigin) : undefined,
  overlayWakeup: config.databaseUrlDirect ? createDirectOverlayWakeup(config.databaseUrlDirect) : undefined,
  paymentOrders,
  paymentSubscriptions,
  publicPaymentStatus: sql ? createPublicPaymentStatusRepository(sql) : undefined,
  maintenance: sql ? createSqlMaintenanceStore(sql) : undefined,
  serviceIdentity,
  readiness: sql ? createSqlReadiness(sql) : undefined,
  notifications: sql ? createSqlNotificationStore(sql) : undefined,
  notificationTokenProtector: config.notificationTokenEncryptionKey
    ? createNotificationTokenProtector(config.notificationTokenEncryptionKey)
    : undefined,
  paymentAccounts: sql ? createSqlPaymentAccountStore(sql) : undefined,
  paymentLedger: sql ? createSqlPaymentLedgerStore(sql) : undefined,
  admin: sql ? createSqlAdminStore(sql) : undefined,
  emailOutbox: sql ? createSqlEmailOutboxStore(sql) : undefined,
  emailSender: config.resendApiKey && config.resendFromAddress
    ? createResendEmailSender(config.resendApiKey, config.resendFromAddress, config.resendEndpoint)
    : undefined,
  account: sql ? createSqlAccountStore(sql) : undefined,
  publicAbuseGuard: config.publicPaymentTurnstileSecret ? createTurnstileGuard(config.publicPaymentTurnstileSecret) : undefined,
  ttsStore: sql ? createSqlTtsStore(sql) : undefined,
  overlayAudio: sql ? createSqlOverlayAudioStore(sql) : undefined,
  tts: config.sarvamApiKey
    ? createTtsService(createSarvamTtsProvider(config.sarvamApiKey, config.sarvamTtsEndpoint), sql ? createSqlTtsCache(sql) : undefined)
    : createTtsService(undefined, sql ? createSqlTtsCache(sql) : undefined),
});

await app.listen({ host: config.host, port: config.port });
