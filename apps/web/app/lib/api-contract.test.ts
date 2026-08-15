import assert from 'node:assert/strict';
import test from 'node:test';
import { notificationPreferencesInput, parseBindingList, parseBillingView, parseChannelConfig, parseChannelDetails, parseCompanionActionResult, parseCompanionLayout, parseCompanionState, parseCurrentUser, parseEntitlements, parseHistoryPage, parseNotificationDeviceList, parseNotificationPreferences, parseOverlaySession, parseQueueList } from './api';

const channelId = '00000000-0000-4000-8000-000000000001';
const overlayId = '00000000-0000-4000-8000-000000000002';

test('accepts only bounded authenticated channel responses', () => {
  const parsed = parseChannelDetails({
    schemaVersion: 'v1', channelId, handle: 'demo_creator', displayName: 'Demo Creator',
    acceptingTips: true, publicConfigVersion: 2, role: 'owner',
  });
  assert.equal(parsed.channelId, channelId);
  assert.throws(() => parseChannelDetails({ schemaVersion: 'v1', channelId, handle: 'demo creator', displayName: 'Demo', acceptingTips: true, publicConfigVersion: 1 }), /invalid_response/);
  assert.throws(() => parseChannelDetails({ schemaVersion: 'v1', channelId, handle: 'demo', displayName: '', acceptingTips: true, publicConfigVersion: 1 }), /invalid_response/);
  assert.throws(() => parseChannelDetails({ schemaVersion: 'v1', channelId, handle: 'demo', displayName: 'Demo', acceptingTips: true, publicConfigVersion: 0 }), /invalid_response/);
  assert.throws(() => parseChannelDetails({ schemaVersion: 'v1', channelId, handle: 'demo', displayName: 'Demo', acceptingTips: true, publicConfigVersion: 1, internalSecret: 'must-not-cross' }), /invalid_response/);
});

test('rejects expanded identity and companion projections', () => {
  assert.equal(parseCurrentUser({ schemaVersion: 'v1', userId: channelId, displayName: null, channels: [{ channelId, role: 'owner' }] }).channels[0]?.role, 'owner');
  assert.throws(() => parseCurrentUser({ schemaVersion: 'v1', userId: 'not-a-user', displayName: null, channels: [] }), /invalid_response/);
  assert.throws(() => parseCurrentUser({ schemaVersion: 'v1', userId: channelId, displayName: null, channels: [{ channelId, role: 'owner', email: 'private@example.test' }] }), /invalid_response/);
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
  assert.equal(parseHistoryPage({ schemaVersion: 'v1', items: [{ eventId: overlayId, sourceType: 'manual', status: 'accepted', createdAt: '2099-08-15T10:00:00.000Z' }], nextCursor: null }).items[0]?.grossAmountPaise, null);
  assert.equal(parseBillingView({ schemaVersion: 'v1', channelId, tier: 'creator', monthlyPricePaise: 39900, annualMonthsCharged: 10, annualServiceMonths: 12, renewalState: 'active', nextRenewalAt: null, billingInterval: 'annual', autoRenew: true, currentPeriodEndsAt: '2099-09-15T10:00:00.000Z', priceProtectedUntil: null, priceSource: 'current' }).tier, 'creator');
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
