export type ChannelRole = 'owner' | 'admin' | 'operator' | 'moderator' | 'viewer';
export type CurrentUser = {
  schemaVersion: 'v1';
  userId: string;
  displayName: string | null;
  channels: Array<{ channelId: string; role: ChannelRole }>;
};
export type AccountSession = { sessionId: string; createdAt: string; lastSeenAt: string; current: boolean; deviceLabel: string | null };
export type NotificationPreferences = { schemaVersion: 'v1'; connectionAlerts: boolean; securityAlerts: boolean; actionFailures: boolean };
export type NotificationDevice = { schemaVersion: 'v1'; deviceId: string; platform: 'ios' | 'android'; enabled: boolean; createdAt: string; lastSeenAt: string };

export type ChannelDetails = { schemaVersion: 'v1'; channelId: string; handle: string; displayName: string; acceptingTips: boolean; publicConfigVersion: number; avatarUrl?: string | null; role?: ChannelRole };
export type ConfigBracket = { amountMinPaise: number; amountMaxPaise: number | null; charLimit: number; ttsEligible: boolean; displayStyle: NonNullable<ChannelConfigValues['defaultStyle']>; displayMinMs: number; ttsOverflowPolicy: 'extend' | 'truncate_speech' | 'truncate_visual' | 'visual_only' | 'disable' };
export type TtsConfig = { enabled?: boolean; voiceId?: string; language?: string; overflowPolicy?: ConfigBracket['ttsOverflowPolicy']; paddingMs?: number };
export type ChannelConfigValues = {
  minimumTipPaise?: number;
  defaultDisplaySeconds?: number;
  defaultStyle?: 'small_pill' | 'compact_card' | 'standard_card' | 'large_card' | 'banner' | 'celebration';
  locale?: string;
  reducedMotion?: boolean;
  brackets?: ConfigBracket[];
  tts?: TtsConfig;
  display?: { anchor?: string; offsetX?: number; offsetY?: number; scale?: number; widthPercent?: number; maxVisibleItems?: number };
  queue?: { mode?: 'fifo' | 'stacked' | 'pills' | 'aggregated' | 'priority'; stackLimit?: number; aggregationWindowSeconds?: number; aggregationThreshold?: number; rateLimitPerMinute?: number; approvalRequired?: boolean; quietMode?: { enabled: boolean; start?: string; end?: string; timezone: string } };
};
export type ChannelConfig = { schemaVersion: 'v1'; channelId: string; version: number; values: ChannelConfigValues; effectiveAt: string };
export type Queue = { schemaVersion: 'v1'; queueId: string; channelId: string; name: string; paused: boolean; active: boolean };
export type QueueBinding = { schemaVersion: 'v1'; bindingId: string; channelId: string; queueId: string; sourceType: 'payment' | 'manual' | 'companion'; sourceId: string; allowDuplicates: boolean; priority: number; overrideValues: Record<string, unknown> | null; active: boolean };
export type AlertHistory = { eventId: string; sourceType: string; status: string; createdAt: string; displayName: string | null; message: string | null; grossAmountPaise: number | null; currency: string | null };
export type CompanionState = { schemaVersion: 'v1'; channelId: string; overlayConnected: boolean; pendingAlerts: number; lastUpdatedAt: string };
export type CompanionActionSlot = { slotIndex: number; page: number; label: string; action: CompanionAction; targetId: string };
export type CompanionLayout = { schemaVersion: 'v1'; channelId: string; version: number; tier: 'free' | 'pro' | 'creator' | 'studio'; maxSlots: 8 | 16 | 32 | 64; pageSize: 4 | 8 | 16; slots: CompanionActionSlot[]; createdAt: string | null };
export type OverlaySession = { schemaVersion: 'v1'; overlayId: string; expiresAt: string; streamUrl: string };
export type CompanionAction = 'pause_queue' | 'resume_queue' | 'send_test_alert';
export type CompanionActionResult = {
  schemaVersion: 'v1';
  commandId: string;
  status: 'accepted' | 'rejected';
  acceptedAt: string;
  eventId?: string;
};
export type BillingView = {
  schemaVersion: 'v1';
  channelId: string;
  tier: 'free' | 'pro' | 'creator' | 'studio';
  monthlyPricePaise: number;
  annualMonthsCharged: number;
  annualServiceMonths: number;
  renewalState: 'not_applicable' | 'active' | 'past_due' | 'cancelled';
  nextRenewalAt: string | null;
  billingInterval: 'monthly' | 'annual';
  autoRenew: boolean;
  currentPeriodEndsAt: string | null;
  priceProtectedUntil: string | null;
  priceSource: 'current' | 'grandfathered';
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const companionTiers = new Set<CompanionLayout['tier']>(['free', 'pro', 'creator', 'studio']);
const companionActions = new Set<CompanionAction>(['pause_queue', 'resume_queue', 'send_test_alert']);
const styles = new Set<NonNullable<ChannelConfigValues['defaultStyle']>>(['small_pill', 'compact_card', 'standard_card', 'large_card', 'banner', 'celebration']);
const overflowPolicies = new Set<ConfigBracket['ttsOverflowPolicy']>(['extend', 'truncate_speech', 'truncate_visual', 'visual_only', 'disable']);
const queueModes = new Set<NonNullable<NonNullable<ChannelConfigValues['queue']>['mode']>>(['fifo', 'stacked', 'pills', 'aggregated', 'priority']);
const anchors = new Set(['top_left', 'top_center', 'top_right', 'center_left', 'center', 'center_right', 'bottom_left', 'bottom_center', 'bottom_right']);
const locales = new Set(['en-IN', 'hi-IN', 'bn-IN', 'ta-IN', 'te-IN', 'mr-IN', 'gu-IN', 'kn-IN', 'ml-IN', 'pa-IN', 'or-IN', 'as-IN', 'ur-IN']);
const sourceTypes = new Set<QueueBinding['sourceType']>(['payment', 'manual', 'companion']);
const historyStatuses = new Set(['accepted', 'held', 'displayed', 'acknowledged', 'failed', 'quarantined', 'suppressed']);
const moderationActions = new Set(['approve', 'hold', 'suppress', 'replay']);
const billingTiers = new Set<BillingView['tier']>(['free', 'pro', 'creator', 'studio']);
const billingRenewalStates = new Set<BillingView['renewalState']>(['not_applicable', 'active', 'past_due', 'cancelled']);
const billingIntervals = new Set<BillingView['billingInterval']>(['monthly', 'annual']);
const priceSources = new Set<BillingView['priceSource']>(['current', 'grandfathered']);
const channelRoles = new Set<ChannelRole>(['owner', 'admin', 'operator', 'moderator', 'viewer']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && uuidPattern.test(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function invalidResponse(): never {
  throw new Error('invalid_response');
}

function requireV1(value: unknown): asserts value is Record<string, unknown> {
  if (!isRecord(value) || value.schemaVersion !== 'v1') invalidResponse();
}

export function parseChannelDetails(value: unknown): ChannelDetails {
  requireV1(value);
  if (!hasOnlyKeys(value, new Set(['schemaVersion', 'channelId', 'handle', 'displayName', 'acceptingTips', 'avatarUrl', 'publicConfigVersion', 'role'])) || !isUuid(value.channelId) || typeof value.handle !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(value.handle) || typeof value.displayName !== 'string' || value.displayName.trim().length === 0 || value.displayName.length > 120 || typeof value.acceptingTips !== 'boolean' || (value.avatarUrl !== undefined && value.avatarUrl !== null && (typeof value.avatarUrl !== 'string' || value.avatarUrl.length > 2048 || !/^https?:\/\//i.test(value.avatarUrl))) || !isSafeInteger(value.publicConfigVersion) || value.publicConfigVersion < 1 || (value.role !== undefined && (typeof value.role !== 'string' || !channelRoles.has(value.role as ChannelRole)))) invalidResponse();
  return {
    schemaVersion: 'v1', channelId: value.channelId, handle: value.handle, displayName: value.displayName,
    acceptingTips: value.acceptingTips, publicConfigVersion: value.publicConfigVersion,
    ...(value.avatarUrl !== undefined ? { avatarUrl: value.avatarUrl as string | null } : {}),
    ...(value.role !== undefined ? { role: value.role as ChannelRole } : {}),
  };
}

function parseConfigValues(value: unknown): ChannelConfigValues {
  if (!isRecord(value)) invalidResponse();
  const allowed = new Set(['minimumTipPaise', 'defaultDisplaySeconds', 'defaultStyle', 'locale', 'reducedMotion', 'brackets', 'tts', 'display', 'queue']);
  if (!hasOnlyKeys(value, allowed)) invalidResponse();
  if (value.minimumTipPaise !== undefined && (!isSafeInteger(value.minimumTipPaise) || value.minimumTipPaise < 1_000 || value.minimumTipPaise > 1_000_000_000)) invalidResponse();
  if (value.defaultDisplaySeconds !== undefined && (!isSafeInteger(value.defaultDisplaySeconds) || value.defaultDisplaySeconds < 4 || value.defaultDisplaySeconds > 60)) invalidResponse();
  if (value.defaultStyle !== undefined && (typeof value.defaultStyle !== 'string' || !styles.has(value.defaultStyle as NonNullable<ChannelConfigValues['defaultStyle']>))) invalidResponse();
  if (value.locale !== undefined && (typeof value.locale !== 'string' || !locales.has(value.locale))) invalidResponse();
  if (value.reducedMotion !== undefined && typeof value.reducedMotion !== 'boolean') invalidResponse();
  if (value.brackets !== undefined) {
    if (!Array.isArray(value.brackets) || value.brackets.length < 1 || value.brackets.length > 64) invalidResponse();
    for (const bracket of value.brackets) {
      if (!isRecord(bracket) || !hasOnlyKeys(bracket, new Set(['amountMinPaise', 'amountMaxPaise', 'charLimit', 'ttsEligible', 'displayStyle', 'displayMinMs', 'ttsOverflowPolicy'])) || !isSafeInteger(bracket.amountMinPaise) || bracket.amountMinPaise < 1_000 || (bracket.amountMaxPaise !== null && (!isSafeInteger(bracket.amountMaxPaise) || bracket.amountMaxPaise < bracket.amountMinPaise)) || !isSafeInteger(bracket.charLimit) || bracket.charLimit < 10 || bracket.charLimit > 500 || typeof bracket.ttsEligible !== 'boolean' || typeof bracket.displayStyle !== 'string' || !styles.has(bracket.displayStyle as NonNullable<ChannelConfigValues['defaultStyle']>) || !isSafeInteger(bracket.displayMinMs) || bracket.displayMinMs < 4_000 || bracket.displayMinMs > 60_000 || typeof bracket.ttsOverflowPolicy !== 'string' || !overflowPolicies.has(bracket.ttsOverflowPolicy as ConfigBracket['ttsOverflowPolicy'])) invalidResponse();
    }
  }
  if (value.tts !== undefined) {
    if (!isRecord(value.tts) || !hasOnlyKeys(value.tts, new Set(['enabled', 'voiceId', 'language', 'overflowPolicy', 'paddingMs']))) invalidResponse();
    if (value.tts.enabled !== undefined && typeof value.tts.enabled !== 'boolean') invalidResponse();
    if (value.tts.voiceId !== undefined && (typeof value.tts.voiceId !== 'string' || value.tts.voiceId.length > 80 || !/^[A-Za-z0-9._:-]+$/.test(value.tts.voiceId))) invalidResponse();
    if (value.tts.language !== undefined && (typeof value.tts.language !== 'string' || !locales.has(value.tts.language))) invalidResponse();
    if (value.tts.overflowPolicy !== undefined && (typeof value.tts.overflowPolicy !== 'string' || !overflowPolicies.has(value.tts.overflowPolicy as ConfigBracket['ttsOverflowPolicy']))) invalidResponse();
    if (value.tts.paddingMs !== undefined && (!isSafeInteger(value.tts.paddingMs) || value.tts.paddingMs < 0 || value.tts.paddingMs > 10_000)) invalidResponse();
  }
  if (value.display !== undefined) {
    if (!isRecord(value.display) || !hasOnlyKeys(value.display, new Set(['anchor', 'offsetX', 'offsetY', 'scale', 'widthPercent', 'maxVisibleItems']))) invalidResponse();
    if (value.display.anchor !== undefined && (typeof value.display.anchor !== 'string' || !anchors.has(value.display.anchor))) invalidResponse();
    if (value.display.offsetX !== undefined && (!isSafeInteger(value.display.offsetX) || value.display.offsetX < -10_000 || value.display.offsetX > 10_000)) invalidResponse();
    if (value.display.offsetY !== undefined && (!isSafeInteger(value.display.offsetY) || value.display.offsetY < -10_000 || value.display.offsetY > 10_000)) invalidResponse();
    if (value.display.scale !== undefined && (!isFiniteNumber(value.display.scale) || value.display.scale < 0.5 || value.display.scale > 2)) invalidResponse();
    if (value.display.widthPercent !== undefined && (!isSafeInteger(value.display.widthPercent) || value.display.widthPercent < 10 || value.display.widthPercent > 100)) invalidResponse();
    if (value.display.maxVisibleItems !== undefined && (!isSafeInteger(value.display.maxVisibleItems) || value.display.maxVisibleItems < 1 || value.display.maxVisibleItems > 10)) invalidResponse();
  }
  if (value.queue !== undefined) {
    if (!isRecord(value.queue) || !hasOnlyKeys(value.queue, new Set(['mode', 'stackLimit', 'aggregationWindowSeconds', 'aggregationThreshold', 'rateLimitPerMinute', 'approvalRequired', 'quietMode']))) invalidResponse();
    if (value.queue.mode !== undefined && (typeof value.queue.mode !== 'string' || !queueModes.has(value.queue.mode as NonNullable<NonNullable<ChannelConfigValues['queue']>['mode']>))) invalidResponse();
    if (value.queue.stackLimit !== undefined && (!isSafeInteger(value.queue.stackLimit) || value.queue.stackLimit < 1 || value.queue.stackLimit > 10)) invalidResponse();
    if (value.queue.aggregationWindowSeconds !== undefined && (!isSafeInteger(value.queue.aggregationWindowSeconds) || value.queue.aggregationWindowSeconds < 1 || value.queue.aggregationWindowSeconds > 300)) invalidResponse();
    if (value.queue.aggregationThreshold !== undefined && (!isSafeInteger(value.queue.aggregationThreshold) || value.queue.aggregationThreshold < 2 || value.queue.aggregationThreshold > 100)) invalidResponse();
    if (value.queue.rateLimitPerMinute !== undefined && (!isSafeInteger(value.queue.rateLimitPerMinute) || value.queue.rateLimitPerMinute < 1 || value.queue.rateLimitPerMinute > 1_000)) invalidResponse();
    if (value.queue.approvalRequired !== undefined && typeof value.queue.approvalRequired !== 'boolean') invalidResponse();
    if (value.queue.quietMode !== undefined) {
      const quietMode = value.queue.quietMode;
      if (!isRecord(quietMode) || !hasOnlyKeys(quietMode, new Set(['enabled', 'start', 'end', 'timezone'])) || typeof quietMode.enabled !== 'boolean' || typeof quietMode.timezone !== 'string' || quietMode.timezone.length < 1 || quietMode.timezone.length > 64 || (quietMode.start !== undefined && (typeof quietMode.start !== 'string' || !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(quietMode.start))) || (quietMode.end !== undefined && (typeof quietMode.end !== 'string' || !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(quietMode.end)))) invalidResponse();
    }
  }
  return value as unknown as ChannelConfigValues;
}

export function parseChannelConfig(value: unknown): ChannelConfig {
  requireV1(value);
  if (!hasOnlyKeys(value, new Set(['schemaVersion', 'channelId', 'version', 'values', 'effectiveAt'])) || !isUuid(value.channelId) || !isSafeInteger(value.version) || value.version < 1 || !isIsoDate(value.effectiveAt)) invalidResponse();
  return { schemaVersion: 'v1', channelId: value.channelId, version: value.version, values: parseConfigValues(value.values), effectiveAt: value.effectiveAt };
}

function parseQueue(value: unknown): Queue {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['schemaVersion', 'queueId', 'channelId', 'name', 'paused', 'active'])) || value.schemaVersion !== 'v1' || !isUuid(value.queueId) || !isUuid(value.channelId) || typeof value.name !== 'string' || value.name.trim().length === 0 || value.name.length > 80 || typeof value.paused !== 'boolean' || typeof value.active !== 'boolean') invalidResponse();
  return { schemaVersion: 'v1', queueId: value.queueId, channelId: value.channelId, name: value.name, paused: value.paused, active: value.active };
}

export function parseOverlaySession(value: unknown): OverlaySession {
  requireV1(value);
  if (!hasOnlyKeys(value, new Set(['schemaVersion', 'overlayId', 'expiresAt', 'streamUrl'])) || !isUuid(value.overlayId) || !isIsoDate(value.expiresAt) || typeof value.streamUrl !== 'string' || value.streamUrl.length > 2048) invalidResponse();
  let url: URL;
  try { url = new URL(value.streamUrl); } catch { invalidResponse(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.search !== '' || url.username !== '' || url.password !== '' || url.pathname !== `/overlay/${value.overlayId}` || !url.hash.startsWith('#token=') || url.hash.length <= '#token='.length) invalidResponse();
  return value as unknown as OverlaySession;
}

export function parseCurrentUser(value: unknown): CurrentUser {
  requireV1(value);
  if (!hasOnlyKeys(value, new Set(['schemaVersion', 'userId', 'displayName', 'channels'])) || !isUuid(value.userId) || (value.displayName !== null && (typeof value.displayName !== 'string' || value.displayName.length > 120)) || !Array.isArray(value.channels)) invalidResponse();
  if (!value.channels.every((channel) => isRecord(channel) && hasOnlyKeys(channel, new Set(['channelId', 'role'])) && isUuid(channel.channelId) && typeof channel.role === 'string' && channelRoles.has(channel.role as ChannelRole))) invalidResponse();
  return { schemaVersion: 'v1', userId: value.userId, displayName: value.displayName as string | null, channels: value.channels.map((channel) => ({ channelId: (channel as Record<string, unknown>).channelId as string, role: (channel as Record<string, unknown>).role as ChannelRole })) };
}

export function parseSessionList(value: unknown): { schemaVersion: 'v1'; sessions: AccountSession[] } {
  requireV1(value);
  if (!hasOnlyKeys(value, new Set(['schemaVersion', 'sessions'])) || !Array.isArray(value.sessions) || value.sessions.length > 64) invalidResponse();
  const sessions = value.sessions.map((session) => {
    if (!isRecord(session) || !hasOnlyKeys(session, new Set(['sessionId', 'createdAt', 'lastSeenAt', 'current', 'deviceLabel'])) || !isUuid(session.sessionId) || !isIsoDate(session.createdAt) || !isIsoDate(session.lastSeenAt) || typeof session.current !== 'boolean' || (session.deviceLabel !== null && (typeof session.deviceLabel !== 'string' || session.deviceLabel.length > 80))) invalidResponse();
    return { sessionId: session.sessionId, createdAt: session.createdAt, lastSeenAt: session.lastSeenAt, current: session.current, deviceLabel: session.deviceLabel as string | null };
  });
  return { schemaVersion: 'v1', sessions };
}

export function parseNotificationPreferences(value: unknown): NotificationPreferences {
  requireV1(value);
  if (!hasOnlyKeys(value, new Set(['schemaVersion', 'connectionAlerts', 'securityAlerts', 'actionFailures'])) || typeof value.connectionAlerts !== 'boolean' || typeof value.securityAlerts !== 'boolean' || typeof value.actionFailures !== 'boolean') invalidResponse();
  return { schemaVersion: 'v1', connectionAlerts: value.connectionAlerts, securityAlerts: value.securityAlerts, actionFailures: value.actionFailures };
}

export function notificationPreferencesInput(value: NotificationPreferences): Omit<NotificationPreferences, 'schemaVersion'> {
  return { connectionAlerts: value.connectionAlerts, securityAlerts: value.securityAlerts, actionFailures: value.actionFailures };
}

function parseNotificationDevice(value: unknown): NotificationDevice {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['schemaVersion', 'deviceId', 'platform', 'enabled', 'createdAt', 'lastSeenAt'])) || value.schemaVersion !== 'v1' || !isUuid(value.deviceId) || (value.platform !== 'ios' && value.platform !== 'android') || typeof value.enabled !== 'boolean' || !isIsoDate(value.createdAt) || !isIsoDate(value.lastSeenAt)) invalidResponse();
  return { schemaVersion: 'v1', deviceId: value.deviceId, platform: value.platform, enabled: value.enabled, createdAt: value.createdAt, lastSeenAt: value.lastSeenAt };
}

export function parseNotificationDeviceList(value: unknown): { schemaVersion: 'v1'; devices: NotificationDevice[] } {
  requireV1(value);
  if (!hasOnlyKeys(value, new Set(['schemaVersion', 'devices'])) || !Array.isArray(value.devices) || value.devices.length > 64) invalidResponse();
  return { schemaVersion: 'v1', devices: value.devices.map(parseNotificationDevice) };
}

export function parseCompanionState(value: unknown): CompanionState {
  requireV1(value);
  if (!hasOnlyKeys(value, new Set(['schemaVersion', 'channelId', 'overlayConnected', 'pendingAlerts', 'lastUpdatedAt'])) || !isUuid(value.channelId) || typeof value.overlayConnected !== 'boolean' || !isSafeInteger(value.pendingAlerts) || value.pendingAlerts < 0 || !isIsoDate(value.lastUpdatedAt)) invalidResponse();
  return { schemaVersion: 'v1', channelId: value.channelId, overlayConnected: value.overlayConnected, pendingAlerts: value.pendingAlerts, lastUpdatedAt: value.lastUpdatedAt };
}

export function parseQueueList(value: unknown): { schemaVersion: 'v1'; queues: Queue[] } {
  requireV1(value);
  if (!hasOnlyKeys(value, new Set(['schemaVersion', 'queues'])) || !Array.isArray(value.queues) || value.queues.length > 256) invalidResponse();
  return { schemaVersion: 'v1', queues: value.queues.map(parseQueue) };
}

function parseBindingOverride(value: unknown): Record<string, unknown> | null {
  if (value === null) return null;
  if (!isRecord(value) || Object.keys(value).length > 16 || !hasOnlyKeys(value, new Set(['style', 'displayStyle', 'anchor', 'scale', 'reducedMotion', 'ttsEnabled', 'rateLimitPerMinute', 'rateLimitPerMin', 'bracket']))) invalidResponse();
  if (value.style !== undefined && (typeof value.style !== 'string' || value.style.length < 1 || value.style.length > 80 || !/^[A-Za-z0-9._:-]+$/.test(value.style))) invalidResponse();
  if (value.displayStyle !== undefined && (typeof value.displayStyle !== 'string' || !styles.has(value.displayStyle as NonNullable<ChannelConfigValues['defaultStyle']>))) invalidResponse();
  if (value.anchor !== undefined && (typeof value.anchor !== 'string' || !anchors.has(value.anchor))) invalidResponse();
  if (value.scale !== undefined && (!isFiniteNumber(value.scale) || value.scale < 0.5 || value.scale > 2)) invalidResponse();
  if (value.reducedMotion !== undefined && typeof value.reducedMotion !== 'boolean') invalidResponse();
  if (value.ttsEnabled !== undefined && typeof value.ttsEnabled !== 'boolean') invalidResponse();
  for (const key of ['rateLimitPerMinute', 'rateLimitPerMin']) {
    const rate = value[key];
    if (rate !== undefined && (!isSafeInteger(rate) || rate < 1 || rate > 1_000)) invalidResponse();
  }
  if (value.bracket !== undefined) {
    if (!isRecord(value.bracket) || Object.keys(value.bracket).length > 5 || !hasOnlyKeys(value.bracket, new Set(['charLimit', 'displayMinMs', 'displayStyle', 'ttsEligible', 'ttsOverflowPolicy']))) invalidResponse();
    if (value.bracket.charLimit !== undefined && (!isSafeInteger(value.bracket.charLimit) || value.bracket.charLimit < 10 || value.bracket.charLimit > 500)) invalidResponse();
    if (value.bracket.displayMinMs !== undefined && (!isSafeInteger(value.bracket.displayMinMs) || value.bracket.displayMinMs < 4_000 || value.bracket.displayMinMs > 60_000)) invalidResponse();
    if (value.bracket.displayStyle !== undefined && (typeof value.bracket.displayStyle !== 'string' || !styles.has(value.bracket.displayStyle as NonNullable<ChannelConfigValues['defaultStyle']>))) invalidResponse();
    if (value.bracket.ttsEligible !== undefined && typeof value.bracket.ttsEligible !== 'boolean') invalidResponse();
    if (value.bracket.ttsOverflowPolicy !== undefined && (typeof value.bracket.ttsOverflowPolicy !== 'string' || !overflowPolicies.has(value.bracket.ttsOverflowPolicy as ConfigBracket['ttsOverflowPolicy']))) invalidResponse();
  }
  return value;
}

function parseBinding(value: unknown): QueueBinding {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['schemaVersion', 'bindingId', 'channelId', 'queueId', 'sourceType', 'sourceId', 'allowDuplicates', 'priority', 'overrideValues', 'active'])) || value.schemaVersion !== 'v1' || !isUuid(value.bindingId) || !isUuid(value.channelId) || !isUuid(value.queueId) || typeof value.sourceType !== 'string' || !sourceTypes.has(value.sourceType as QueueBinding['sourceType']) || typeof value.sourceId !== 'string' || value.sourceId.length < 1 || value.sourceId.length > 160 || typeof value.allowDuplicates !== 'boolean' || !isSafeInteger(value.priority) || value.priority < 0 || value.priority > 100_000 || typeof value.active !== 'boolean') invalidResponse();
  return { schemaVersion: 'v1', bindingId: value.bindingId, channelId: value.channelId, queueId: value.queueId, sourceType: value.sourceType as QueueBinding['sourceType'], sourceId: value.sourceId, allowDuplicates: value.allowDuplicates, priority: value.priority, overrideValues: parseBindingOverride(value.overrideValues ?? null), active: value.active };
}

export function parseBindingList(value: unknown): { schemaVersion: 'v1'; bindings: QueueBinding[] } {
  requireV1(value);
  if (!hasOnlyKeys(value, new Set(['schemaVersion', 'bindings'])) || !Array.isArray(value.bindings) || value.bindings.length > 256) invalidResponse();
  return { schemaVersion: 'v1', bindings: value.bindings.map(parseBinding) };
}

function parseHistoryItem(value: unknown): AlertHistory {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['eventId', 'sourceType', 'status', 'createdAt', 'grossAmountPaise', 'currency', 'displayName', 'message'])) || !isUuid(value.eventId) || typeof value.sourceType !== 'string' || !sourceTypes.has(value.sourceType as QueueBinding['sourceType']) || typeof value.status !== 'string' || !historyStatuses.has(value.status) || !isIsoDate(value.createdAt)) invalidResponse();
  if (value.grossAmountPaise !== undefined && value.grossAmountPaise !== null && (!isSafeInteger(value.grossAmountPaise) || value.grossAmountPaise < 0)) invalidResponse();
  if (value.currency !== undefined && value.currency !== null && value.currency !== 'INR') invalidResponse();
  if (value.displayName !== undefined && value.displayName !== null && (typeof value.displayName !== 'string' || value.displayName.length > 80)) invalidResponse();
  if (value.message !== undefined && value.message !== null && (typeof value.message !== 'string' || value.message.length > 500)) invalidResponse();
  return { eventId: value.eventId, sourceType: value.sourceType, status: value.status, createdAt: value.createdAt, grossAmountPaise: (value.grossAmountPaise ?? null) as number | null, currency: (value.currency ?? null) as string | null, displayName: (value.displayName ?? null) as string | null, message: (value.message ?? null) as string | null };
}

export function parseHistoryPage(value: unknown): { schemaVersion: 'v1'; items: AlertHistory[]; nextCursor: string | null } {
  requireV1(value);
  if (!hasOnlyKeys(value, new Set(['schemaVersion', 'items', 'nextCursor'])) || !Array.isArray(value.items) || value.items.length > 100 || (value.nextCursor !== null && (typeof value.nextCursor !== 'string' || value.nextCursor.length > 256))) invalidResponse();
  return { schemaVersion: 'v1', items: value.items.map(parseHistoryItem), nextCursor: value.nextCursor as string | null };
}

function parseModerationResult(value: unknown): { schemaVersion: 'v1'; eventId: string; action: string; appliedAt: string } {
  requireV1(value);
  if (!hasOnlyKeys(value, new Set(['schemaVersion', 'eventId', 'action', 'appliedAt'])) || !isUuid(value.eventId) || typeof value.action !== 'string' || !moderationActions.has(value.action) || !isIsoDate(value.appliedAt)) invalidResponse();
  return { schemaVersion: 'v1', eventId: value.eventId, action: value.action, appliedAt: value.appliedAt };
}

function parseAlertAccepted(value: unknown): { schemaVersion: 'v1'; eventId: string; traceId: string; status: 'accepted' | 'held' } {
  requireV1(value);
  if (!hasOnlyKeys(value, new Set(['schemaVersion', 'eventId', 'traceId', 'status'])) || !isUuid(value.eventId) || typeof value.traceId !== 'string' || value.traceId.length < 1 || value.traceId.length > 128 || (value.status !== 'accepted' && value.status !== 'held')) invalidResponse();
  return { schemaVersion: 'v1', eventId: value.eventId, traceId: value.traceId, status: value.status };
}

export function parseBillingView(value: unknown): BillingView {
  requireV1(value);
  if (!hasOnlyKeys(value, new Set(['schemaVersion', 'channelId', 'tier', 'monthlyPricePaise', 'annualMonthsCharged', 'annualServiceMonths', 'renewalState', 'nextRenewalAt', 'billingInterval', 'autoRenew', 'currentPeriodEndsAt', 'priceProtectedUntil', 'priceSource'])) || !isUuid(value.channelId) || typeof value.tier !== 'string' || !billingTiers.has(value.tier as BillingView['tier']) || !isSafeInteger(value.monthlyPricePaise) || value.monthlyPricePaise < 0 || value.monthlyPricePaise > 1_000_000_000 || value.annualMonthsCharged !== 10 || value.annualServiceMonths !== 12 || typeof value.renewalState !== 'string' || !billingRenewalStates.has(value.renewalState as BillingView['renewalState']) || typeof value.billingInterval !== 'string' || !billingIntervals.has(value.billingInterval as BillingView['billingInterval']) || typeof value.autoRenew !== 'boolean' || (value.nextRenewalAt !== null && !isIsoDate(value.nextRenewalAt)) || (value.currentPeriodEndsAt !== null && !isIsoDate(value.currentPeriodEndsAt)) || (value.priceProtectedUntil !== null && !isIsoDate(value.priceProtectedUntil)) || typeof value.priceSource !== 'string' || !priceSources.has(value.priceSource as BillingView['priceSource'])) invalidResponse();
  return value as unknown as BillingView;
}

export function parseEntitlements(value: unknown): { schemaVersion: 'v1'; channelId: string; tier: BillingView['tier']; source: 'individual_plan'; entitlementVersion: number; values: Record<string, unknown> } {
  requireV1(value);
  if (!hasOnlyKeys(value, new Set(['schemaVersion', 'channelId', 'tier', 'source', 'entitlementVersion', 'values'])) || !isUuid(value.channelId) || typeof value.tier !== 'string' || !billingTiers.has(value.tier as BillingView['tier']) || value.source !== 'individual_plan' || !isSafeInteger(value.entitlementVersion) || value.entitlementVersion < 1 || !isRecord(value.values)) invalidResponse();
  return { schemaVersion: 'v1', channelId: value.channelId, tier: value.tier as BillingView['tier'], source: 'individual_plan', entitlementVersion: value.entitlementVersion, values: value.values };
}

export function parseCompanionLayout(value: unknown): CompanionLayout {
  requireV1(value);
  const maxSlots = value.maxSlots;
  const pageSize = value.pageSize;
  if (!hasOnlyKeys(value, new Set(['schemaVersion', 'channelId', 'version', 'tier', 'maxSlots', 'pageSize', 'slots', 'createdAt'])) || !isUuid(value.channelId) || !isSafeInteger(value.version) || !isSafeInteger(maxSlots) || !isSafeInteger(pageSize) || !companionTiers.has(value.tier as CompanionLayout['tier']) || ![8, 16, 32, 64].includes(maxSlots) || ![4, 8, 16].includes(pageSize) || (value.createdAt !== null && !isIsoDate(value.createdAt)) || !Array.isArray(value.slots)) invalidResponse();
  if (!value.slots.every((slot) => isRecord(slot) && hasOnlyKeys(slot, new Set(['slotIndex', 'page', 'label', 'action', 'targetId'])) && isSafeInteger(slot.slotIndex) && slot.slotIndex >= 1 && slot.slotIndex <= maxSlots && isSafeInteger(slot.page) && slot.page >= 1 && slot.page <= 16 && typeof slot.label === 'string' && slot.label.length >= 1 && slot.label.length <= 80 && companionActions.has(slot.action as CompanionAction) && isUuid(slot.targetId))) invalidResponse();
  const indexes = value.slots.map((slot) => (slot as Record<string, unknown>).slotIndex as number);
  if (new Set(indexes).size !== indexes.length) invalidResponse();
  return value as unknown as CompanionLayout;
}

function parseAccessToken(value: unknown): { accessToken: string } {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['accessToken'])) || typeof value.accessToken !== 'string' || value.accessToken.length < 32 || value.accessToken.length > 256) invalidResponse();
  return { accessToken: value.accessToken };
}

export function parseCompanionActionResult(value: unknown): CompanionActionResult {
  requireV1(value);
  if (!hasOnlyKeys(value, new Set(['schemaVersion', 'commandId', 'status', 'acceptedAt', 'eventId'])) || !isUuid(value.commandId) || (value.status !== 'accepted' && value.status !== 'rejected') || !isIsoDate(value.acceptedAt) || (value.eventId !== undefined && !isUuid(value.eventId))) invalidResponse();
  return { schemaVersion: 'v1', commandId: value.commandId, status: value.status, acceptedAt: value.acceptedAt, ...(value.eventId !== undefined ? { eventId: value.eventId } : {}) };
}

const TOKEN_KEY = 'bharatstudio.alerts.session';

function pathSegment(value: string): string {
  return encodeURIComponent(value);
}

export function getAccessToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.sessionStorage.getItem(TOKEN_KEY);
}

export function storeAccessToken(token: string): void {
  window.sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearAccessToken(): void {
  window.sessionStorage.removeItem(TOKEN_KEY);
}

export async function exchangeGoogleCredential(credential: string): Promise<void> {
  const response = await fetch(`${getApiOrigin()}/v1/auth/google/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken: credential, deviceLabel: 'BharatStudio web' }),
  });
  if (!response.ok) throw new Error('Sign-in could not be completed');
  let data: { accessToken: string };
  try { data = parseAccessToken(await response.json()); } catch { throw new Error('Sign-in response was invalid'); }
  storeAccessToken(data.accessToken);
}

export async function getCurrentUser(): Promise<CurrentUser> {
  const token = getAccessToken();
  if (!token) throw new Error('Authentication required');
  const response = await fetch(`${getApiOrigin()}/v1/me`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
  if (!response.ok) throw new Error(response.status === 401 ? 'Authentication required' : 'Account data is temporarily unavailable');
  try { return parseCurrentUser(await response.json()); } catch { throw new Error('Account data is temporarily unavailable'); }
}

export function getSessions(): Promise<{ schemaVersion: 'v1'; sessions: AccountSession[] }> { return apiFetch('/v1/me/sessions', {}, parseSessionList); }
export function revokeSession(sessionId: string): Promise<void> { return apiFetch<void>(`/v1/me/sessions/${pathSegment(sessionId)}`, { method: 'DELETE' }, rejectUnexpectedBody); }
export function getNotificationPreferences(): Promise<NotificationPreferences> { return apiFetch('/v1/me/notifications/preferences', {}, parseNotificationPreferences); }
export function updateNotificationPreferences(preferences: Omit<NotificationPreferences, 'schemaVersion'>): Promise<NotificationPreferences> {
  return apiFetch('/v1/me/notifications/preferences', { method: 'PUT', body: JSON.stringify(preferences) }, parseNotificationPreferences);
}
export function getNotificationDevices(): Promise<{ schemaVersion: 'v1'; devices: NotificationDevice[] }> { return apiFetch('/v1/me/notifications/devices', {}, parseNotificationDeviceList); }

function rejectUnexpectedBody(_value: unknown): never {
  invalidResponse();
}

async function apiFetch<T>(path: string, init: RequestInit = {}, decode: (value: unknown) => T): Promise<T> {
  const token = getAccessToken();
  if (!token) throw new Error('Authentication required');
  const response = await fetch(`${getApiOrigin()}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
    cache: 'no-store',
  });
  if (!response.ok) {
    if (response.status === 401) throw new Error('Authentication required');
    let message = 'Request could not be completed';
    try {
      const body = await response.json() as { message?: unknown };
      if (typeof body.message === 'string' && body.message.length <= 180) message = body.message;
    } catch { /* Keep the bounded generic message for non-JSON failures. */ }
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  try {
    return decode(await response.json());
  } catch {
    throw new Error('Server response was invalid');
  }
}

export function createChannel(handle: string, displayName: string): Promise<ChannelDetails> {
  return apiFetch('/v1/channels', { method: 'POST', body: JSON.stringify({ handle, displayName }) }, parseChannelDetails);
}

export function getChannel(channelId: string): Promise<ChannelDetails> { return apiFetch(`/v1/channels/${pathSegment(channelId)}`, {}, parseChannelDetails); }
export function getChannelConfig(channelId: string): Promise<ChannelConfig> { return apiFetch(`/v1/channels/${pathSegment(channelId)}/config`, {}, parseChannelConfig); }
export function updateChannelConfig(channelId: string, version: number, values: ChannelConfigValues): Promise<ChannelConfig> {
  return apiFetch(`/v1/channels/${pathSegment(channelId)}/config`, { method: 'PATCH', headers: { 'if-match-version': String(version) }, body: JSON.stringify({ values }) }, parseChannelConfig);
}
export function getQueues(channelId: string): Promise<{ schemaVersion: 'v1'; queues: Queue[] }> { return apiFetch(`/v1/channels/${pathSegment(channelId)}/queues`, {}, parseQueueList); }
export function createQueue(channelId: string, name: string): Promise<Queue> { return apiFetch(`/v1/channels/${pathSegment(channelId)}/queues`, { method: 'POST', body: JSON.stringify({ name }) }, parseQueue); }
export function updateQueue(channelId: string, queueId: string, input: { paused?: boolean; active?: boolean; name?: string }): Promise<Queue> { return apiFetch(`/v1/channels/${pathSegment(channelId)}/queues/${pathSegment(queueId)}`, { method: 'PATCH', body: JSON.stringify(input) }, parseQueue); }
export function getBindings(channelId: string): Promise<{ schemaVersion: 'v1'; bindings: QueueBinding[] }> { return apiFetch(`/v1/channels/${pathSegment(channelId)}/bindings`, {}, parseBindingList); }
export function createBinding(channelId: string, input: { queueId: string; sourceType: QueueBinding['sourceType']; sourceId: string; allowDuplicates: boolean; priority: number }): Promise<QueueBinding> { return apiFetch(`/v1/channels/${pathSegment(channelId)}/bindings`, { method: 'POST', body: JSON.stringify(input) }, parseBinding); }
export function updateBinding(channelId: string, bindingId: string, input: { allowDuplicates?: boolean; priority?: number; overrideValues?: Record<string, unknown> | null; active?: boolean }): Promise<QueueBinding> { return apiFetch(`/v1/channels/${pathSegment(channelId)}/bindings/${pathSegment(bindingId)}`, { method: 'PATCH', body: JSON.stringify(input) }, parseBinding); }
export function getHistory(channelId: string): Promise<{ schemaVersion: 'v1'; items: AlertHistory[]; nextCursor: string | null }> { return apiFetch(`/v1/channels/${pathSegment(channelId)}/alert-history`, {}, parseHistoryPage); }
export function moderateAlert(channelId: string, alertId: string, action: 'approve' | 'hold' | 'suppress' | 'replay'): Promise<{ eventId: string; action: string; appliedAt: string }> { return apiFetch(`/v1/channels/${pathSegment(channelId)}/moderation/${pathSegment(alertId)}`, { method: 'POST', body: JSON.stringify({ action }) }, parseModerationResult); }
export function sendTestAlert(channelId: string, displayName: string, message: string): Promise<{ schemaVersion: 'v1'; eventId: string; traceId: string; status: 'accepted' | 'held' }> { return apiFetch(`/v1/channels/${pathSegment(channelId)}/test-alert`, { method: 'POST', body: JSON.stringify({ displayName, message }) }, parseAlertAccepted); }
export function getBilling(channelId: string): Promise<BillingView> { return apiFetch(`/v1/channels/${pathSegment(channelId)}/billing`, {}, parseBillingView); }
export function getEntitlements(channelId: string): Promise<{ schemaVersion: 'v1'; channelId: string; tier: BillingView['tier']; source: 'individual_plan'; entitlementVersion: number; values: Record<string, unknown> }> { return apiFetch(`/v1/channels/${pathSegment(channelId)}/entitlements`, {}, parseEntitlements); }
export function getCompanionState(channelId: string): Promise<CompanionState> { return apiFetch(`/v1/channels/${pathSegment(channelId)}/companion/state`, {}, parseCompanionState); }
export function getCompanionLayout(channelId: string): Promise<CompanionLayout> { return apiFetch(`/v1/channels/${pathSegment(channelId)}/companion/layout`, {}, parseCompanionLayout); }
export function updateCompanionLayout(channelId: string, version: number, pageSize: 4 | 8 | 16, slots: CompanionActionSlot[]): Promise<CompanionLayout> {
  return apiFetch<CompanionLayout>(`/v1/channels/${pathSegment(channelId)}/companion/layout`, { method: 'PATCH', headers: { 'if-match-version': String(version) }, body: JSON.stringify({ pageSize, slots }) }, parseCompanionLayout);
}
export function createOverlaySession(channelId: string): Promise<OverlaySession> { return apiFetch(`/v1/channels/${pathSegment(channelId)}/overlay/session`, { method: 'POST' }, parseOverlaySession); }
export function rotateOverlaySession(overlayId: string): Promise<OverlaySession> { return apiFetch(`/v1/overlays/${pathSegment(overlayId)}/rotate`, { method: 'POST' }, parseOverlaySession); }
export function revokeOverlaySession(overlayId: string): Promise<void> { return apiFetch<void>(`/v1/overlays/${pathSegment(overlayId)}`, { method: 'DELETE' }, rejectUnexpectedBody); }
export function executeCompanionAction(channelId: string, action: CompanionAction, targetId: string): Promise<CompanionActionResult> {
  if (!isUuid(targetId)) throw new Error('companion_target_required');
  if (!globalThis.crypto?.randomUUID) throw new Error('secure_random_unavailable');
  return apiFetch(`/v1/channels/${pathSegment(channelId)}/companion/actions`, { method: 'POST', headers: { 'Idempotency-Key': globalThis.crypto.randomUUID() }, body: JSON.stringify({ action, targetId }) }, parseCompanionActionResult);
}
import { getApiOrigin } from './api-origin';
