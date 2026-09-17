import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPublicChannelRepository, createSqlClient } from './db/public-channel-repository.js';
import { createPublicPaymentStatusRepository } from './db/public-payment-status-repository.js';
import { createGoogleIdentityVerifier } from './auth/google.js';
import { createSqlSessionStore } from './auth/session-store.js';
import { createSqlChannelStore } from './db/channel-store.js';
import { createSqlAlertStore } from './db/alert-store.js';
import { createSqlCompanionPairingStore } from './db/companion-pairing-store.js';
import { createSqlOverlayStore } from './db/overlay-store.js';
import { createDirectOverlayWakeup } from './db/overlay-wakeup.js';
import { createApiMetrics } from './observability/metrics.js';
import { createGooglePaymentOrderService } from './db/payment-order-client.js';
import { createGooglePaymentSubscriptionService } from './db/payment-subscription-client.js';
import { createGoogleServiceIdentityVerifier } from './auth/service-identity.js';
import { createSqlMaintenanceStore } from './db/maintenance-store.js';
import { createSqlReadiness } from './db/readiness.js';
import { createSqlNotificationStore } from './db/notification-store.js';
import { createNotificationTokenProtector } from './notifications/token-crypto.js';
import { createSqlPaymentAccountStore } from './db/payment-account-store.js';
import { createSqlInsightsStore } from './db/insights-store.js';
import { createSqlPaymentLedgerStore } from './db/payment-ledger.js';
import { createSqlAdminStore } from './db/admin-store.js';
import { createSqlEmailOutboxStore } from './db/email-store.js';
import { createResendEmailSender } from './email/resend-sender.js';
import { createSqlReferralStore } from './db/referral-store.js';
import { createSqlBrandingStore } from './db/branding-store.js';
import { createSqlOverlayBrandingStore } from './db/overlay-branding-store.js';
import { createSqlAccountStore } from './db/account-store.js';
import { createTurnstileGuard } from './domain/public-abuse.js';
import { createSqlTtsStore } from './db/tts-store.js';
import { createSqlTtsQuotaMeter } from './db/tts-quota-store.js';
import { createSqlViewerStore } from './db/viewer-store.js';
import { createSqlYoutubeConnectionStore } from './db/youtube-connection-store.js';
import { loadYoutubeOAuthConfig } from './domain/youtube-oauth-config.js';
import { createYoutubeOAuthClient } from './domain/youtube-oauth-client.js';
import { createBillingPaymentMethodService } from './db/billing-payment-method-client.js';
import { createSqlCompanionFeatureStore } from './db/companion-feature-store.js';
import { createSqlCompanionEntitlementStore } from './db/companion-entitlement-sql-store.js';
import { createSqlSeatStore } from './db/seat-store.js';
import { createSqlGoalStore } from './db/goal-store.js';
import { createSqlGoalOverlayStore } from './db/goal-overlay-store.js';
import { createSqlMasterCanvasOverlayStore, createSqlMasterCanvasStore } from './db/master-canvas-sql-store.js';
import { createSqlModeratorStatusOverlayStore } from './db/moderator-status-overlay-store.js';
import { createSqlReactionCloudOverlayStore } from './db/reaction-cloud-overlay-store.js';
import { createSqlReactionSendStore } from './db/reaction-send-store.js';
import { createSqlSafeModeStore } from './db/safe-mode-store.js';
// PRF-02 slice 6, §6 catalogue module #16 (Lobby Status). Two files, two
// pools, deliberately -- see each store file's own header.
import { createSqlLobbySessionStore } from './db/lobby-status-store.js';
import { createSqlLobbyStatusOverlayStore } from './db/lobby-status-overlay-store.js';
// PRF-02 slice 5, §6 catalogue module #9 (Stream Mission Card). Two files,
// two pools, deliberately -- see each store file's own header.
import { createSqlStreamMissionStore } from './db/stream-mission-store.js';
import { createSqlStreamMissionOverlayStore } from './db/stream-mission-overlay-store.js';
import { createSqlReputationStore } from './db/reputation-sql-store.js';
import { createSqlProviderCapabilitySnapshotStore } from './db/payment-provider-capability-snapshot-store.js';
import { createSqlChallengeStore } from './db/challenge-store.js';
import { createSqlChallengeOverlayStore } from './db/challenge-overlay-store.js';
import { createSqlTemplateCatalogueStore } from './db/template-catalogue-store.js';
import { createSqlStickerCatalogueStore } from './db/sticker-catalogue-store.js';
import { createSqlPublicStickerCatalogueStore, createSqlStickerSelectionStore } from './db/sticker-public-store.js';
import { createSqlCreatorPackStore, createSqlPublicCreatorPackStore, createSqlCreatorPackSelectionStore } from './db/sticker-creator-pack-store.js';
import { createSqlInteractionDefinitionStore, createSqlSupportVoteStore, createSqlPublicVoteStore, createSqlHypeModeStore, createSqlWidgetConfigStore, createSqlLeaderboardStore, createSqlInteractionOverlayStore } from './db/interaction-sql-store.js';
import { createSqlPaidSupportVoteStore, createSqlPaidVoteOverlayStore, createSqlPublicPaidVoteStore, createSqlTugOfWarVoteOverlayStore, createSqlVotePaymentTagStore } from './db/vote-payment-sql-store.js';
import { createSqlIngestFailureStore } from './db/ingest-failure-store.js';
import { createSqlStaffCreatorPackReviewStore } from './db/staff-creator-pack-review-store.js';
import { createSqlAssistStore } from './db/assist-sql-store.js';
import { createSqlOverlayAudioStore } from './db/overlay-audio-store.js';
import { createSqlTtsCache } from './db/tts-cache.js';
import { createSarvamTtsProvider, createTtsService } from './tts/provider.js';
import { createDerivedReadSql } from './db/derived-read-pool.js';

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
const alerts = sql ? createSqlAlertStore(sql) : undefined;
const sharedTokenProtector = config.notificationTokenEncryptionKey
  ? createNotificationTokenProtector(config.notificationTokenEncryptionKey)
  : undefined;
const youtubeOAuthConfig = loadYoutubeOAuthConfig();
// RT-02 §3.4: created once, up front, so the direct listener's notification
// counters (routed vs unroutable) and buildApp's request/replay/admission
// counters are the SAME instance rather than two independent counter sets.
const metrics = createApiMetrics();
// RT-10/RT-11 (§19.0, §31.18.0): the derived-read `Sql` handle for
// widget/dashboard/analytics reads only — see db/derived-read-pool.ts.
// Unset config (both fields undefined) makes this literally `sql`, the same
// instance every other store already uses; that is the kill switch.
const derivedReadSql = sql
  ? createDerivedReadSql(
    sql,
    config.databaseUrlApp,
    { poolMax: config.derivedReadPoolMax, statementTimeoutMs: config.derivedReadStatementTimeoutMs },
    () => metrics.recordDerivedReadTimeout(),
  )
  : undefined;
const app = await buildApp(config, {
  publicChannels: sql ? createPublicChannelRepository(sql) : undefined,
  google: config.googleClientId ? createGoogleIdentityVerifier(config.googleClientId) : undefined,
  sessions: sql ? createSqlSessionStore(sql) : undefined,
  channels: sql ? createSqlChannelStore(sql) : undefined,
  alerts,
  companionPairing: sql && alerts ? createSqlCompanionPairingStore(sql, alerts, `${config.appOrigin.replace(/\/+$/, '')}/companion/pair`) : undefined,
  overlays: sql ? createSqlOverlayStore(sql, config.appOrigin) : undefined,
  overlayWakeup: config.databaseUrlDirect
    ? createDirectOverlayWakeup(config.databaseUrlDirect, {
      maxInstanceSubscribers: config.overlayMaxInstanceSubscribers,
      maxChannelSubscribers: config.overlayMaxChannelSubscribers,
      onNotification: (outcome) => metrics.recordOverlayNotification(outcome),
    })
    : undefined,
  metrics,
  paymentOrders,
  paymentSubscriptions,
  publicPaymentStatus: sql ? createPublicPaymentStatusRepository(sql) : undefined,
  maintenance: sql ? createSqlMaintenanceStore(sql) : undefined,
  serviceIdentity,
  readiness: sql ? createSqlReadiness(sql) : undefined,
  notifications: sql ? createSqlNotificationStore(sql) : undefined,
  notificationTokenProtector: sharedTokenProtector,
  paymentAccounts: sql ? createSqlPaymentAccountStore(sql) : undefined,
  paymentLedger: sql ? createSqlPaymentLedgerStore(derivedReadSql!) : undefined,
  // OPS-08 / OPS-11 (derivable subset). Dashboard-facing derived reads --
  // same RT-10/RT-11 pool as paymentLedger, not the main request pool.
  insights: sql ? createSqlInsightsStore(derivedReadSql!) : undefined,
  admin: sql ? createSqlAdminStore(sql) : undefined,
  emailOutbox: sql ? createSqlEmailOutboxStore(sql) : undefined,
  emailSender: config.resendApiKey && config.resendFromAddress
    ? createResendEmailSender(config.resendApiKey, config.resendFromAddress, config.resendEndpoint)
    : undefined,
  account: sql ? createSqlAccountStore(sql) : undefined,
  referrals: sql ? createSqlReferralStore(sql) : undefined,
  branding: sql ? createSqlBrandingStore(sql) : undefined,
  overlayBranding: sql ? createSqlOverlayBrandingStore(sql) : undefined,
  publicAbuseGuard: config.publicPaymentTurnstileSecret ? createTurnstileGuard(config.publicPaymentTurnstileSecret) : undefined,
  ttsStore: sql ? createSqlTtsStore(sql) : undefined,
  ttsQuotaMeter: sql ? createSqlTtsQuotaMeter(sql) : undefined,
  viewer: sql ? createSqlViewerStore(sql) : undefined,
  youtubeConnections: sql && sharedTokenProtector ? createSqlYoutubeConnectionStore(sql, sharedTokenProtector) : undefined,
  youtubeOAuthClient: youtubeOAuthConfig ? createYoutubeOAuthClient(youtubeOAuthConfig) : undefined,
  companionFeatures: sql ? createSqlCompanionFeatureStore(sql) : undefined,
  companionEntitlement: sql ? createSqlCompanionEntitlementStore(sql) : undefined,
  seats: sql ? createSqlSeatStore(sql) : undefined,
  goals: sql ? createSqlGoalStore(sql) : undefined,
  overlayGoals: sql ? createSqlGoalOverlayStore(derivedReadSql!) : undefined,
  masterCanvasModules: sql ? createSqlMasterCanvasStore(sql) : undefined,
  overlayMasterCanvasModules: sql ? createSqlMasterCanvasOverlayStore(derivedReadSql!) : undefined,
  // PRF-02 slice 5, §6 module #12 (held half only). On the RT-10/RT-11
  // derived-read pool like every other widget/overlay read -- which is
  // also what puts it inside rule 3 of the RT-12 required-queries scan.
  overlayModeratorStatus: sql ? createSqlModeratorStatusOverlayStore(derivedReadSql!) : undefined,
  // PRF-02 slice 6 / PRF-06, §6 module #5 (Reaction Cloud).
  //
  // The overlay read is on the RT-10/RT-11 derived-read pool like every
  // other widget/overlay read -- which is also what puts it inside rule 3
  // of the RT-12 required-queries scan. It is constructed with
  // `config.reactionCloudSampleMax`, the CONFIGURED-BUT-UNSET display
  // ceiling: unset here means unset in the SQL LIMIT, which means today's
  // behaviour. No `??` fallback, and there must not be one.
  //
  // The SEND path is a WRITE and takes the MAIN pool, never derivedReadSql
  // -- that pool exists for widget/dashboard/analytics reads, and routing
  // a write through it would misuse both the pool and its statement
  // timeout.
  overlayReactionCloud: sql ? createSqlReactionCloudOverlayStore(derivedReadSql!, config.reactionCloudSampleMax) : undefined,
  reactionSends: sql ? createSqlReactionSendStore(sql) : undefined,
  // PRF-02, §6 module #12: safe mode, the creator's own switch. On the
  // MAIN pool, not derivedReadSql -- it carries a write, and putting a
  // write on the bounded derived-read pool would be wrong twice over
  // (see db/safe-mode-store.ts's own header). That also keeps it
  // correctly outside rule 3 of the RT-12 required-queries scan.
  safeMode: sql ? createSqlSafeModeStore(sql) : undefined,
  // PRF-02 slice 6, §6 module #16 (Lobby Status).
  //
  // The creator store carries writes, so it uses the MAIN pool exactly as
  // goals/challenges/streamMissions do -- which also keeps it correctly
  // outside rule 3 of the RT-12 required-queries scan. The overlay store
  // is a derived read on the RT-10/RT-11 derivedReadSql pool like every
  // other widget/overlay read, which is what puts it INSIDE rule 3.
  //
  // Neither is constructed with a tier, a ceiling or any other
  // configuration value: the Creator+/Events-Pack entitlement lives inside
  // app_private.list_overlay_lobby_status (migration 0140), where the SQL
  // test can prove it, and nothing here may add a second copy of it.
  lobbySessions: sql ? createSqlLobbySessionStore(sql) : undefined,
  overlayLobbyStatus: sql ? createSqlLobbyStatusOverlayStore(derivedReadSql!) : undefined,
  // PRF-02 slice 5, module #9. The creator store carries writes, so it
  // uses the main pool exactly as goals/challenges/masterCanvasModules do;
  // the overlay store is a derived read and uses derivedReadSql, which is
  // also what makes it visible to rule 3 of scan-required-queries.mjs.
  streamMissions: sql ? createSqlStreamMissionStore(sql) : undefined,
  overlayStreamMission: sql ? createSqlStreamMissionOverlayStore(derivedReadSql!) : undefined,
  reputation: sql ? createSqlReputationStore(sql) : undefined,
  capabilitySnapshots: sql ? createSqlProviderCapabilitySnapshotStore(sql) : undefined,
  challenges: sql ? createSqlChallengeStore(sql) : undefined,
  overlayChallenges: sql ? createSqlChallengeOverlayStore(derivedReadSql!) : undefined,
  interactionDefinitions: sql ? createSqlInteractionDefinitionStore(sql) : undefined,
  interactionVotes: sql ? createSqlSupportVoteStore(sql) : undefined,
  interactionPublicVotes: sql ? createSqlPublicVoteStore(sql) : undefined,
  interactionHype: sql ? createSqlHypeModeStore(sql) : undefined,
  interactionWidgets: sql ? createSqlWidgetConfigStore(sql) : undefined,
  interactionLeaderboard: sql ? createSqlLeaderboardStore(sql) : undefined,
  interactionOverlay: sql ? createSqlInteractionOverlayStore(derivedReadSql!) : undefined,
  votePaymentTags: sql ? createSqlVotePaymentTagStore(sql) : undefined,
  publicPaidVotes: sql ? createSqlPublicPaidVoteStore(sql) : undefined,
  paidVotes: sql ? createSqlPaidSupportVoteStore(sql) : undefined,
  paidVoteOverlay: sql ? createSqlPaidVoteOverlayStore(derivedReadSql!) : undefined,
  // PRF-02 slice 2, module #3 (Tug-of-War Vote).
  tugOfWarVoteOverlay: sql ? createSqlTugOfWarVoteOverlayStore(derivedReadSql!) : undefined,
  templates: sql ? createSqlTemplateCatalogueStore(sql) : undefined,
  stickers: sql ? createSqlStickerCatalogueStore(sql) : undefined,
  publicStickers: sql ? createSqlPublicStickerCatalogueStore(sql) : undefined,
  stickerSelections: sql ? createSqlStickerSelectionStore(sql) : undefined,
  creatorPack: sql ? createSqlCreatorPackStore(sql) : undefined,
  publicCreatorPack: sql ? createSqlPublicCreatorPackStore(sql) : undefined,
  creatorPackSelections: sql ? createSqlCreatorPackSelectionStore(sql) : undefined,
  ingestFailures: sql ? createSqlIngestFailureStore(sql) : undefined,
  staffCreatorPackReview: sql ? createSqlStaffCreatorPackReviewStore(sql) : undefined,
  assist: sql ? createSqlAssistStore(sql) : undefined,
  sql,
  derivedReadSql,
  paymentMethodUpdates: sql && config.paymentServiceOrigin && config.paymentServiceAudience
    ? createBillingPaymentMethodService(sql, config.paymentServiceOrigin, config.paymentServiceAudience, config.nodeEnv)
    : undefined,
  overlayAudio: sql ? createSqlOverlayAudioStore(sql) : undefined,
  tts: config.sarvamApiKey
    ? createTtsService(createSarvamTtsProvider(config.sarvamApiKey, config.sarvamTtsEndpoint), sql ? createSqlTtsCache(sql) : undefined)
    : createTtsService(undefined, sql ? createSqlTtsCache(sql) : undefined),
});

await app.listen({ host: config.host, port: config.port });
