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
});

await app.listen({ host: config.host, port: config.port });
