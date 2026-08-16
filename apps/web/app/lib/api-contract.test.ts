import assert from 'node:assert/strict';
import test from 'node:test';
import { isApprovedCheckoutUrl, notificationPreferencesInput, parseAccessToken, parseBillingSubscription, parseBindingList, parseBillingView, parseChannelConfig, parseChannelDetails, parseCompanionActionResult, parseCompanionLayout, parseCompanionState, parseCurrentUser, parseEntitlements, parseHistoryPage, parseLifecycleResult, parseLottieAssetList, parseNotificationDeviceList, parseNotificationPreferences, parseOverlaySession, parsePaymentAccountList, parsePaymentLedgerPage, parsePrivacyRequestList, parseQueueList, parseReferralHistory, parseReferralOverview, parseTermsStatus } from './api';

const channelId = '00000000-0000-4000-8000-000000000001';
const overlayId = '00000000-0000-4000-8000-000000000002';

test('accepts only bounded authenticated channel responses', () => {
  const parsed = parseChannelDetails({
    schemaVersion: 'v1', channelId, handle: 'demo_creator', displayName: 'Demo Creator',
    acceptingTips: true, publicConfigVersion: 2, featuredConsent: true, role: 'owner',
  });
  assert.equal(parsed.channelId, channelId);
  assert.equal(parsed.featuredConsent, true);
  assert.throws(() => parseChannelDetails({ schemaVersion: 'v1', channelId, handle: 'demo creator', displayName: 'Demo', acceptingTips: true, publicConfigVersion: 1, featuredConsent: false }), /invalid_response/);
  assert.throws(() => parseChannelDetails({ schemaVersion: 'v1', channelId, handle: 'demo', displayName: '', acceptingTips: true, publicConfigVersion: 1, featuredConsent: false }), /invalid_response/);
  assert.throws(() => parseChannelDetails({ schemaVersion: 'v1', channelId, handle: 'demo', displayName: 'Demo', acceptingTips: true, publicConfigVersion: 0, featuredConsent: false }), /invalid_response/);
  assert.throws(() => parseChannelDetails({ schemaVersion: 'v1', channelId, handle: 'demo', displayName: 'Demo', acceptingTips: true, publicConfigVersion: 1, featuredConsent: false, internalSecret: 'must-not-cross' }), /invalid_response/);
  assert.throws(() => parseChannelDetails({ schemaVersion: 'v1', channelId, handle: 'demo', displayName: 'Demo', acceptingTips: true, publicConfigVersion: 1 }), /invalid_response/);
});

test('rejects expanded identity and companion projections', () => {
  assert.equal(parseCurrentUser({ schemaVersion: 'v1', userId: channelId, displayName: null, channels: [{ channelId, role: 'owner', payoutOnboardingDone: false }] }).channels[0]?.role, 'owner');
  assert.throws(() => parseCurrentUser({ schemaVersion: 'v1', userId: 'not-a-user', displayName: null, channels: [] }), /invalid_response/);
  assert.throws(() => parseCurrentUser({ schemaVersion: 'v1', userId: channelId, displayName: null, channels: [{ channelId, role: 'owner', payoutOnboardingDone: false, email: 'private@example.test' }] }), /invalid_response/);
  assert.throws(() => parseCurrentUser({ schemaVersion: 'v1', userId: channelId, displayName: null, channels: [{ channelId, role: 'owner' }] }), /invalid_response/, 'missing payoutOnboardingDone must fail closed, not default silently');
  assert.equal(parseCompanionState({ schemaVersion: 'v1', channelId, overlayConnected: false, pendingAlerts: 0, lastUpdatedAt: '2099-08-15T10:00:00.000Z' }).pendingAlerts, 0);
  assert.throws(() => parseCompanionState({ schemaVersion: 'v1', channelId, overlayConnected: false, pendingAlerts: 0, lastUpdatedAt: '2099-08-15T10:00:00.000Z', internalState: 'hidden' }), /invalid_response/);
});

test('accepts only privacy-minimised notification projections', () => {
  const preferences = parseNotificationPreferences({ schemaVersion: 'v1', connectionAlerts: true, securityAlerts: false, actionFailures: true });
  assert.equal(preferences.securityAlerts, false);
  assert.deepEqual(notificationPreferencesInput(preferences), { connectionAlerts: true, securityAlerts: false, actionFailures: true });
  assert.throws(() => parseNotificationPreferences({ schemaVersion: 'v1', connectionAlerts: true, securityAlerts: false, actionFailures: true, email: 'private@example.test' }), /invalid_response/);
  const devices = parseNotificationDeviceList({ schemaVersion: 'v1', devices: [{ schemaVersion: 'v1', deviceId: overlayId, platform: 'android', enabled: true, createdAt: '2099-08-15T10:00:00.000Z', lastSeenAt: '2099-08-15T10:00:00.000Z' }] });
  assert.equal(devices.devices[0]?.platform, 'android');
  assert.throws(() => parseNotificationDeviceList({ schemaVersion: 'v1', devices: [{ schemaVersion: 'v1', deviceId: overlayId, platform: 'android', enabled: true, createdAt: '2099-08-15T10:00:00.000Z', lastSeenAt: '2099-08-15T10:00:00.000Z', token: 'must-not-cross' }] }), /invalid_response/);
});

test('rejects expanded binding list and nested binding projections', () => {
  const binding = { schemaVersion: 'v1', bindingId: overlayId, channelId, queueId: channelId, sourceType: 'payment', sourceId: 'demo', allowDuplicates: false, priority: 1, overrideValues: null, active: true };
  assert.equal(parseBindingList({ schemaVersion: 'v1', bindings: [binding] }).bindings.length, 1);
  assert.throws(() => parseBindingList({ schemaVersion: 'v1', bindings: [{ ...binding, privateField: 'hidden' }] }), /invalid_response/);
  assert.throws(() => parseBindingList({ schemaVersion: 'v1', bindings: [binding], internalBindings: [] }), /invalid_response/);
});

test('accepts only an overlay URL with a fragment credential and no query credential', () => {
  const parsed = parseOverlaySession({
    schemaVersion: 'v1', overlayId, expiresAt: '2099-08-15T10:00:00.000Z',
    streamUrl: `https://web.example.test/overlay/${overlayId}#token=synthetic-token`,
  });
  assert.equal(parsed.overlayId, overlayId);
  assert.throws(() => parseOverlaySession({ schemaVersion: 'v1', overlayId, expiresAt: '2099-08-15T10:00:00.000Z', streamUrl: `https://web.example.test/overlay/${overlayId}?token=leaked` }), /invalid_response/);
  assert.throws(() => parseOverlaySession({ schemaVersion: 'v1', overlayId, expiresAt: '2099-08-15T10:00:00.000Z', streamUrl: `https://web.example.test/not-overlay/${overlayId}#token=x` }), /invalid_response/);
  assert.throws(() => parseOverlaySession({ schemaVersion: 'v1', overlayId, expiresAt: 'not-a-date', streamUrl: `https://web.example.test/overlay/${overlayId}#token=x` }), /invalid_response/);
  assert.throws(() => parseOverlaySession({ schemaVersion: 'v1', overlayId, expiresAt: '2099-08-15T10:00:00.000Z', streamUrl: `javascript:alert(1)#token=x` }), /invalid_response/);
});

test('bounds authenticated configuration, queues, history, billing and entitlement responses', () => {
  const config = parseChannelConfig({
    schemaVersion: 'v1', channelId, version: 3, effectiveAt: '2099-08-15T10:00:00.000Z',
    values: { minimumTipPaise: 1000, defaultDisplaySeconds: 8, defaultStyle: 'standard_card', locale: 'en-IN', reducedMotion: false,
      brackets: [{ amountMinPaise: 1000, amountMaxPaise: null, charLimit: 120, ttsEligible: true, displayStyle: 'standard_card', displayMinMs: 8000, ttsOverflowPolicy: 'extend' }],
      display: { anchor: 'bottom_center', offsetX: 0, offsetY: 0, scale: 1, widthPercent: 80, maxVisibleItems: 1 },
      queue: { mode: 'fifo', stackLimit: 1, rateLimitPerMinute: 60 } },
  });
  assert.equal(config.values.defaultStyle, 'standard_card');
  assert.equal(parseQueueList({ schemaVersion: 'v1', queues: [{ schemaVersion: 'v1', queueId: overlayId, channelId, name: 'Main alerts', paused: false, active: true }] }).queues.length, 1);
  assert.throws(() => parseQueueList({ schemaVersion: 'v1', queues: [{ schemaVersion: 'v1', queueId: overlayId, channelId, name: 'Main alerts', paused: false, active: true, internalId: 'hidden' }] }), /invalid_response/);
  // Regression: a channel's default queue/binding id is a deterministic
  // md5(...)::uuid, which never sets the RFC4122 v4 version/variant
  // nibbles — a too-strict uuid check silently rejected every real
  // channel's default queue on first live-database verification.
  assert.equal(parseQueueList({ schemaVersion: 'v1', queues: [{ schemaVersion: 'v1', queueId: '99551cc1-6b3a-4d2a-251f-953fc7324a9b', channelId, name: 'Main alerts', paused: false, active: true }] }).queues.length, 1);
  assert.throws(() => parseQueueList({ schemaVersion: 'v1', queues: [{ schemaVersion: 'v1', queueId: 'not-a-uuid', channelId, name: 'Main alerts', paused: false, active: true }] }), /invalid_response/);
  assert.equal(parseHistoryPage({ schemaVersion: 'v1', items: [{ eventId: overlayId, sourceType: 'manual', status: 'accepted', createdAt: '2099-08-15T10:00:00.000Z' }], nextCursor: null }).items[0]?.grossAmountPaise, null);
  assert.equal(parseBillingView({ schemaVersion: 'v1', channelId, tier: 'creator', monthlyPricePaise: 39900, annualMonthsCharged: 10, annualServiceMonths: 12, renewalState: 'active', nextRenewalAt: null, billingInterval: 'annual', autoRenew: true, currentPeriodEndsAt: '2099-09-15T10:00:00.000Z', priceProtectedUntil: null, priceSource: 'current' }).tier, 'creator');
  // Regression: a monthly billing view's genuinely correct 1/1 shape was
  // rejected by a hardcoded annual-only (10/12) check — caught on a real
  // end-to-end browser run against a live monthly subscription, not by
  // any prior unit test (every existing fixture used billingInterval:
  // 'annual' throughout).
  assert.equal(parseBillingView({ schemaVersion: 'v1', channelId, tier: 'studio', monthlyPricePaise: 49900, annualMonthsCharged: 1, annualServiceMonths: 1, renewalState: 'active', nextRenewalAt: '2099-09-15T10:00:00.000Z', billingInterval: 'monthly', autoRenew: true, currentPeriodEndsAt: '2099-09-15T10:00:00.000Z', priceProtectedUntil: null, priceSource: 'grandfathered' }).annualMonthsCharged, 1);
  assert.throws(() => parseBillingView({ schemaVersion: 'v1', channelId, tier: 'studio', monthlyPricePaise: 49900, annualMonthsCharged: 10, annualServiceMonths: 12, renewalState: 'active', nextRenewalAt: '2099-09-15T10:00:00.000Z', billingInterval: 'monthly', autoRenew: true, currentPeriodEndsAt: '2099-09-15T10:00:00.000Z', priceProtectedUntil: null, priceSource: 'grandfathered' }), /invalid_response/);
  assert.equal(parseEntitlements({ schemaVersion: 'v1', channelId, tier: 'creator', source: 'individual_plan', entitlementVersion: 2, values: { queueCount: 16 } }).values.queueCount, 16);
  assert.equal(parseCompanionLayout({ schemaVersion: 'v1', channelId, version: 4, tier: 'creator', maxSlots: 32, pageSize: 8, slots: [{ slotIndex: 1, page: 1, label: 'Pause', action: 'pause_queue', targetId: overlayId }], createdAt: '2099-08-15T10:00:00.000Z' }).slots.length, 1);
  assert.throws(() => parseChannelConfig({ schemaVersion: 'v1', channelId, version: 3, effectiveAt: '2099-08-15T10:00:00.000Z', values: { minimumTipPaise: 999 } }), /invalid_response/);
  assert.throws(() => parseQueueList({ schemaVersion: 'v1', queues: [{ schemaVersion: 'v1', queueId: overlayId, channelId, name: '', paused: false, active: true }] }), /invalid_response/);
  assert.throws(() => parseHistoryPage({ schemaVersion: 'v1', items: [{ eventId: overlayId, sourceType: 'manual', status: 'accepted', createdAt: 'not-a-date', message: '<script>' }], nextCursor: null }), /invalid_response/);
  assert.throws(() => parseBillingView({ schemaVersion: 'v1', channelId, tier: 'creator', monthlyPricePaise: -1, annualMonthsCharged: 10, annualServiceMonths: 12, renewalState: 'active', nextRenewalAt: null, billingInterval: 'annual', autoRenew: true, currentPeriodEndsAt: null, priceProtectedUntil: null, priceSource: 'current' }), /invalid_response/);
  assert.throws(() => parseEntitlements({ schemaVersion: 'v1', channelId, tier: 'creator', source: 'unknown', entitlementVersion: 2, values: {} }), /invalid_response/);
  assert.equal(parseEntitlements({ schemaVersion: 'v1', channelId, tier: 'creator', source: 'individual_plan', entitlementVersion: 2, values: {} }).source, 'individual_plan');
  assert.throws(() => parseBillingView({ schemaVersion: 'v1', channelId, tier: 'creator', monthlyPricePaise: 39900, annualMonthsCharged: 10, annualServiceMonths: 12, renewalState: 'active', nextRenewalAt: null, billingInterval: 'annual', autoRenew: true, currentPeriodEndsAt: null, priceProtectedUntil: null, priceSource: 'current', internalPriceRule: 'secret' }), /invalid_response/);
  assert.throws(() => parseCompanionLayout({ schemaVersion: 'v1', channelId, version: 4, tier: 'creator', maxSlots: 32, pageSize: 8, slots: [{ slotIndex: 1, page: 1, label: 'Pause', action: 'pause_queue', targetId: overlayId }, { slotIndex: 1, page: 1, label: 'Duplicate', action: 'resume_queue', targetId: overlayId }], createdAt: null }), /invalid_response/);
});

test('uses the bounded Companion layout contract for mutation responses', () => {
  const parsed = parseCompanionLayout({
    schemaVersion: 'v1', channelId, version: 5, tier: 'studio', maxSlots: 64, pageSize: 16,
    slots: [{ slotIndex: 1, page: 1, label: 'Test alert', action: 'send_test_alert', targetId: overlayId }], createdAt: null,
  });
  assert.equal(parsed.maxSlots, 64);
  assert.throws(() => parseCompanionLayout({
    schemaVersion: 'v1', channelId, version: 5, tier: 'studio', maxSlots: 64, pageSize: 16,
    slots: [{ slotIndex: 1, page: 1, label: 'Test alert', action: 'unsupported', targetId: overlayId }], createdAt: null,
  }), /invalid_response/);
  assert.throws(() => parseCompanionLayout({
    schemaVersion: 'v1', channelId, version: 5, tier: 'studio', maxSlots: 64, pageSize: 16,
    slots: [{ slotIndex: 1, page: 1, label: 'Test alert', action: 'send_test_alert', targetId: overlayId, secret: true }], createdAt: null,
  }), /invalid_response/);
});

test('validates the full Companion action result envelope', () => {
  const commandId = '00000000-0000-4000-8000-000000000003';
  const eventId = '00000000-0000-4000-8000-000000000004';
  const parsed = parseCompanionActionResult({ schemaVersion: 'v1', commandId, status: 'accepted', acceptedAt: '2099-08-15T10:00:00.000Z', eventId });
  assert.equal(parsed.commandId, commandId);
  assert.equal(parsed.eventId, eventId);
  assert.throws(() => parseCompanionActionResult({ schemaVersion: 'v1', commandId, status: 'accepted', acceptedAt: 'not-a-date' }), /invalid_response/);
  assert.throws(() => parseCompanionActionResult({ schemaVersion: 'v1', commandId, status: 'unexpected', acceptedAt: '2099-08-15T10:00:00.000Z' }), /invalid_response/);
  assert.throws(() => parseCompanionActionResult({ schemaVersion: 'v1', commandId, status: 'accepted', acceptedAt: '2099-08-15T10:00:00.000Z', extra: true }), /invalid_response/);
});

test('accepts only the bounded terms status envelope', () => {
  const hash = 'a'.repeat(64);
  const parsed = parseTermsStatus({
    schemaVersion: 'v1',
    documents: [{ documentKey: 'terms_of_service', version: 'v1.0', contentHash: hash, publishedAt: '2099-08-15T10:00:00.000Z' }],
    accepted: false,
  });
  assert.equal(parsed.documents[0]?.documentKey, 'terms_of_service');
  assert.equal(parsed.accepted, false);
  assert.throws(() => parseTermsStatus({ schemaVersion: 'v1', documents: [], accepted: false, extra: true }), /invalid_response/);
  assert.throws(() => parseTermsStatus({ schemaVersion: 'v1', documents: [{ documentKey: 'unknown_document', version: 'v1.0', contentHash: hash, publishedAt: null }], accepted: false }), /invalid_response/);
  assert.throws(() => parseTermsStatus({ schemaVersion: 'v1', documents: [{ documentKey: 'terms_of_service', version: 'v1.0', contentHash: 'not-hex', publishedAt: null }], accepted: false }), /invalid_response/);
});

test('accepts only the bounded privacy-request list envelope', () => {
  const requestId = '00000000-0000-4000-8000-000000000005';
  const parsed = parsePrivacyRequestList({
    schemaVersion: 'v1',
    requests: [{ requestId, requestType: 'access', status: 'open', createdAt: '2099-08-15T10:00:00.000Z' }],
  });
  assert.equal(parsed.requests[0]?.requestType, 'access');
  assert.throws(() => parsePrivacyRequestList({ schemaVersion: 'v1', requests: [{ requestId, requestType: 'unsupported', status: 'open', createdAt: '2099-08-15T10:00:00.000Z' }] }), /invalid_response/);
  assert.throws(() => parsePrivacyRequestList({ schemaVersion: 'v1', requests: [{ requestId: 'not-a-uuid', requestType: 'access', status: 'open', createdAt: '2099-08-15T10:00:00.000Z' }] }), /invalid_response/);
});

test('accepts only the bounded payment-account list envelope', () => {
  const accountId = '00000000-0000-4000-8000-000000000006';
  const parsed = parsePaymentAccountList({
    schemaVersion: 'v1',
    accounts: [{ schemaVersion: 'v1', accountId, channelId, provider: 'razorpay', environment: 'test', connectedAccountRef: 'acc_demo123', status: 'pending', createdAt: '2099-08-15T10:00:00.000Z', updatedAt: '2099-08-15T10:00:00.000Z', revokedAt: null }],
  });
  assert.equal(parsed.accounts[0]?.status, 'pending');
  assert.throws(() => parsePaymentAccountList({ schemaVersion: 'v1', accounts: [{ schemaVersion: 'v1', accountId, channelId, provider: 'other_provider', environment: 'test', connectedAccountRef: 'acc_demo123', status: 'pending', createdAt: '2099-08-15T10:00:00.000Z', updatedAt: '2099-08-15T10:00:00.000Z', revokedAt: null }] }), /invalid_response/);
  assert.throws(() => parsePaymentAccountList({ schemaVersion: 'v1', accounts: [{ schemaVersion: 'v1', accountId, channelId, provider: 'razorpay', environment: 'unexpected', connectedAccountRef: 'acc_demo123', status: 'pending', createdAt: '2099-08-15T10:00:00.000Z', updatedAt: '2099-08-15T10:00:00.000Z', revokedAt: null }] }), /invalid_response/);
});

test('accepts only the bounded billing-subscription contract and checks annual pricing consistency', () => {
  const parsed = parseBillingSubscription({
    schemaVersion: 'v1', provider: 'razorpay', status: 'linked', subscriptionId: 'sub_demo123',
    tier: 'creator', billingInterval: 'annual', monthlyPricePaise: 39900, annualChargePaise: 399000,
    annualMonthsCharged: 10, annualServiceMonths: 12, checkoutUrl: 'https://rzp.io/i/demo',
  });
  assert.equal(parsed.checkoutUrl, 'https://rzp.io/i/demo');
  assert.throws(() => parseBillingSubscription({
    schemaVersion: 'v1', provider: 'razorpay', status: 'linked', subscriptionId: 'sub_demo123',
    tier: 'creator', billingInterval: 'annual', monthlyPricePaise: 39900, annualChargePaise: 399005,
    annualMonthsCharged: 10, annualServiceMonths: 12, checkoutUrl: null,
  }), /invalid_response/);
  assert.throws(() => parseBillingSubscription({
    schemaVersion: 'v1', provider: 'other_provider', status: 'linked', subscriptionId: 'sub_demo123',
    tier: 'creator', billingInterval: 'annual', monthlyPricePaise: 39900, annualChargePaise: 399000,
    annualMonthsCharged: 10, annualServiceMonths: 12, checkoutUrl: null,
  }), /invalid_response/);
  assert.throws(() => parseBillingSubscription({
    schemaVersion: 'v1', provider: 'razorpay', status: 'linked', subscriptionId: 'sub_demo123',
    tier: 'free', billingInterval: 'annual', monthlyPricePaise: 0, annualChargePaise: 0,
    annualMonthsCharged: 10, annualServiceMonths: 12, checkoutUrl: null,
  }), /invalid_response/);
});

test('a monthly subscription is 1 month charged for 1 month of service, not the annual shape — the only interval the Subscribe button actually sends', () => {
  const parsed = parseBillingSubscription({
    schemaVersion: 'v1', provider: 'razorpay', status: 'linked', subscriptionId: 'sub_demo123',
    tier: 'creator', billingInterval: 'monthly', monthlyPricePaise: 39900, annualChargePaise: 39900,
    annualMonthsCharged: 1, annualServiceMonths: 1, checkoutUrl: 'https://rzp.io/i/demo',
  });
  assert.equal(parsed.annualMonthsCharged, 1);
  assert.equal(parsed.annualServiceMonths, 1);
  assert.throws(() => parseBillingSubscription({
    schemaVersion: 'v1', provider: 'razorpay', status: 'linked', subscriptionId: 'sub_demo123',
    tier: 'creator', billingInterval: 'monthly', monthlyPricePaise: 39900, annualChargePaise: 399000,
    annualMonthsCharged: 10, annualServiceMonths: 12, checkoutUrl: null,
  }), /invalid_response/);
});

test('accepts only the bounded subscription-lifecycle envelope and rejects an action mismatch', () => {
  const parseCancel = parseLifecycleResult('cancel');
  const parsed = parseCancel({ schemaVersion: 'v1', action: 'cancel', requestId: 'req_demo123', status: 'provider_confirmed', replay: false });
  assert.equal(parsed.status, 'provider_confirmed');
  assert.throws(() => parseCancel({ schemaVersion: 'v1', action: 'upgrade', requestId: 'req_demo123', status: 'provider_confirmed', replay: false }), /invalid_response/);
  assert.throws(() => parseCancel({ schemaVersion: 'v1', action: 'cancel', requestId: 'req_demo123', status: 'unknown_status', replay: false }), /invalid_response/);
  assert.throws(() => parseCancel({ schemaVersion: 'v1', action: 'cancel', requestId: 'req_demo123', status: 'provider_confirmed', replay: false, extra: true }), /invalid_response/);
});

test('checkout redirect only ever follows an approved Razorpay domain', () => {
  assert.equal(isApprovedCheckoutUrl('https://rzp.io/i/demo'), true);
  assert.equal(isApprovedCheckoutUrl('https://pages.razorpay.com/checkout/demo'), true);
  assert.equal(isApprovedCheckoutUrl('https://rzp.io.attacker.example/i/demo'), false);
  assert.equal(isApprovedCheckoutUrl('https://attacker.example/?redirect=https://rzp.io/'), false);
});

test('accepts only the bounded payment-ledger page and rejects an unbalanced refund total', () => {
  const paymentId = '00000000-0000-4000-8000-000000000007';
  const parsed = parsePaymentLedgerPage({
    schemaVersion: 'v1',
    items: [{ paymentId, providerPaymentId: 'pay_demo123', grossAmountPaise: 50000, currency: 'INR', status: 'partially_refunded', createdAt: '2099-08-15T10:00:00.000Z', refundTotalPaise: 15000, latestRefundStatus: 'requested' }],
    nextCursor: null,
  });
  assert.equal(parsed.items[0]?.refundTotalPaise, 15000);
  assert.throws(() => parsePaymentLedgerPage({
    schemaVersion: 'v1',
    items: [{ paymentId, providerPaymentId: 'pay_demo123', grossAmountPaise: 50000, currency: 'INR', status: 'captured', createdAt: '2099-08-15T10:00:00.000Z', refundTotalPaise: -1, latestRefundStatus: null }],
    nextCursor: null,
  }), /invalid_response/);
  assert.throws(() => parsePaymentLedgerPage({
    schemaVersion: 'v1',
    items: [{ paymentId, providerPaymentId: 'pay_demo123', grossAmountPaise: 50000, currency: 'INR', status: 'captured', createdAt: '2099-08-15T10:00:00.000Z', refundTotalPaise: 0, latestRefundStatus: 'not_a_real_status' }],
    nextCursor: null,
  }), /invalid_response/);
});

test('accepts a well-formed referral overview and rejects a negative count', () => {
  const overview = { schemaVersion: 'v1', pendingCount: 1, paidPendingHoldCount: 0, creditedCount: 2, flaggedOrRevokedCount: 0, bankedCreditDays: 0, lifetimeCreditedDays: 60 };
  const parsed = parseReferralOverview(overview);
  assert.equal(parsed.lifetimeCreditedDays, 60);
  assert.throws(() => parseReferralOverview({ ...overview, creditedCount: -1 }), /invalid_response/);
  assert.throws(() => parseReferralOverview({ ...overview, extra: true }), /invalid_response/);
});

test('accepts a well-formed referral history page and rejects an unknown status', () => {
  const referralId = '00000000-0000-4000-8000-000000000091';
  const parsed = parseReferralHistory({
    schemaVersion: 'v1',
    items: [{ referralId, status: 'credited', attributedAt: '2026-08-01T10:00:00.000Z', creditedAt: '2026-08-15T10:00:00.000Z', creditDays: 30 }],
  });
  assert.equal(parsed.items[0]?.creditDays, 30);
  assert.throws(() => parseReferralHistory({
    schemaVersion: 'v1',
    items: [{ referralId, status: 'not_a_real_status', attributedAt: '2026-08-01T10:00:00.000Z', creditedAt: null, creditDays: null }],
  }), /invalid_response/);
  assert.throws(() => parseReferralHistory({
    schemaVersion: 'v1',
    items: [{ referralId, status: 'pending', attributedAt: '2026-08-01T10:00:00.000Z', creditedAt: null, creditDays: 0 }],
  }), /invalid_response/);
});

test('accepts a well-formed Lottie asset list and rejects an unknown displayStyle', () => {
  const artifactId = '00000000-0000-4000-8000-000000000091';
  const parsed = parseLottieAssetList({
    schemaVersion: 'v1',
    items: [{ displayStyle: 'celebration', artifactId, byteSize: 1024, updatedAt: '2026-08-16T10:00:00.000Z' }],
  });
  assert.equal(parsed.items[0]?.byteSize, 1024);
  assert.throws(() => parseLottieAssetList({
    schemaVersion: 'v1',
    items: [{ displayStyle: 'not_a_real_style', artifactId, byteSize: 1024, updatedAt: '2026-08-16T10:00:00.000Z' }],
  }), /invalid_response/);
  assert.throws(() => parseLottieAssetList({
    schemaVersion: 'v1',
    items: [{ displayStyle: 'celebration', artifactId, byteSize: 0, updatedAt: '2026-08-16T10:00:00.000Z' }],
  }), /invalid_response/);
});

test('accepts the real POST /v1/auth/google/exchange envelope, not just a bare accessToken', () => {
  // Regression: apps/api/src/routes/auth.ts returns { schemaVersion,
  // accessToken, expiresAt, user }, not a bare { accessToken }. A validator
  // that only allowed the 'accessToken' key rejected every real sign-in
  // response with "Sign-in response was invalid", confirmed live against a
  // real Google account — the exchange succeeded server-side (201) but the
  // client's own envelope check failed closed on the extra fields.
  const token = 'a'.repeat(48);
  const user = { schemaVersion: 'v1' as const, userId: channelId, displayName: 'Demo Creator', channels: [{ channelId, role: 'owner' as const, payoutOnboardingDone: false }] };
  const parsed = parseAccessToken({ schemaVersion: 'v1', accessToken: token, expiresAt: '2099-08-15T10:00:00.000Z', user });
  assert.equal(parsed.accessToken, token);
  assert.throws(() => parseAccessToken({ schemaVersion: 'v1', accessToken: token, expiresAt: '2099-08-15T10:00:00.000Z', user, sessionSecret: 'must-not-cross' }), /invalid_response/);
  assert.throws(() => parseAccessToken({ schemaVersion: 'v1', accessToken: token, expiresAt: 'not-a-date', user }), /invalid_response/);
  assert.throws(() => parseAccessToken({ schemaVersion: 'v1', accessToken: token, expiresAt: '2099-08-15T10:00:00.000Z', user: { ...user, role: 'owner' } }), /invalid_response/);
});
