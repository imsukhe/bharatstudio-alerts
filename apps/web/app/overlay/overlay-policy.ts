export type QueueMode = 'fifo' | 'stacked' | 'pills' | 'aggregated' | 'priority';
export type DisplayStyle = 'small_pill' | 'compact_card' | 'standard_card' | 'large_card' | 'banner' | 'celebration';
export type Anchor = 'top_left' | 'top_center' | 'top_right' | 'center_left' | 'center' | 'center_right' | 'bottom_left' | 'bottom_center' | 'bottom_right';

export type OverlayItem = {
  cursor: string;
  eventId: string;
  eventType: string;
  createdAt?: string;
  payload: Record<string, unknown>;
  arrivalOrder?: number;
};

export type OverlayBracket = {
  amountMinPaise: number;
  amountMaxPaise: number | null;
  charLimit: number;
  displayStyle: DisplayStyle;
  displayMinMs: number;
  ttsEligible: boolean;
  ttsOverflowPolicy: 'extend' | 'truncate_speech' | 'truncate_visual' | 'visual_only' | 'disable';
};

export type OverlayConfig = {
  defaultDisplaySeconds: number;
  defaultStyle: DisplayStyle;
  locale: string;
  reducedMotion: boolean;
  brackets: OverlayBracket[];
  tts: { enabled: boolean; paddingMs: number; overflowPolicy: OverlayBracket['ttsOverflowPolicy'] };
  display: { anchor: Anchor; offsetX: number; offsetY: number; scale: number; widthPercent: number; maxVisibleItems: number };
  queue: { mode: QueueMode; stackLimit: number; aggregationWindowSeconds: number; aggregationThreshold: number };
};

export type TtsPlaybackPlan = { mode: 'audio' | 'chime' | 'silent'; audioUrl?: string };

const overlayEventTypes = new Set(['alert.ready', 'alert.update', 'alert.hold', 'alert.complete', 'resync.required']);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Decode only the approved overlay event envelope. Invalid data is ignored by
 * the presentation layer and remains available for durable replay because the
 * browser never acknowledges a value that fails this boundary.
 */
export function parseOverlayItem(value: unknown): OverlayItem | null {
  if (!isRecord(value) || value.schemaVersion !== 'v1') return null;
  if (typeof value.cursor !== 'string' || value.cursor.length === 0 || value.cursor.length > 256) return null;
  if (typeof value.eventId !== 'string' || !uuidPattern.test(value.eventId)) return null;
  if (typeof value.eventType !== 'string' || !overlayEventTypes.has(value.eventType)) return null;
  if (typeof value.traceId !== 'string' || value.traceId.length === 0 || value.traceId.length > 256) return null;
  if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) return null;
  if (!isRecord(value.payload)) return null;
  return {
    cursor: value.cursor,
    eventId: value.eventId,
    eventType: value.eventType,
    createdAt: value.createdAt,
    payload: value.payload,
  };
}

const STYLES: DisplayStyle[] = ['small_pill', 'compact_card', 'standard_card', 'large_card', 'banner', 'celebration'];
const ANCHORS: Anchor[] = ['top_left', 'top_center', 'top_right', 'center_left', 'center', 'center_right', 'bottom_left', 'bottom_center', 'bottom_right'];
const MODES: QueueMode[] = ['fifo', 'stacked', 'pills', 'aggregated', 'priority'];
const OVERFLOW = ['extend', 'truncate_speech', 'truncate_visual', 'visual_only', 'disable'] as const;

const DEFAULT_CONFIG: OverlayConfig = {
  defaultDisplaySeconds: 8,
  defaultStyle: 'standard_card',
  locale: 'en-IN',
  reducedMotion: false,
  brackets: [{ amountMinPaise: 1000, amountMaxPaise: null, charLimit: 120, displayStyle: 'standard_card', displayMinMs: 8000, ttsEligible: true, ttsOverflowPolicy: 'extend' }],
  tts: { enabled: false, paddingMs: 300, overflowPolicy: 'extend' },
  display: { anchor: 'bottom_center', offsetX: 0, offsetY: 0, scale: 1, widthPercent: 80, maxVisibleItems: 1 },
  queue: { mode: 'fifo', stackLimit: 1, aggregationWindowSeconds: 30, aggregationThreshold: 5 },
};

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function finiteInteger(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

function finiteNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : fallback;
}

function validStyle(value: unknown, fallback: DisplayStyle): DisplayStyle {
  return typeof value === 'string' && STYLES.includes(value as DisplayStyle) ? value as DisplayStyle : fallback;
}

function validAnchor(value: unknown, fallback: Anchor): Anchor {
  return typeof value === 'string' && ANCHORS.includes(value as Anchor) ? value as Anchor : fallback;
}

function validMode(value: unknown, fallback: QueueMode): QueueMode {
  return typeof value === 'string' && MODES.includes(value as QueueMode) ? value as QueueMode : fallback;
}

function validOverflow(value: unknown, fallback: OverlayBracket['ttsOverflowPolicy']): OverlayBracket['ttsOverflowPolicy'] {
  return typeof value === 'string' && OVERFLOW.includes(value as typeof OVERFLOW[number]) ? value as OverlayBracket['ttsOverflowPolicy'] : fallback;
}

export function normalizeOverlayConfig(raw: unknown): OverlayConfig {
  const source = objectValue(raw);
  const display = objectValue(source.display);
  const queue = objectValue(source.queue);
  const tts = objectValue(source.tts);
  const brackets = Array.isArray(source.brackets) ? source.brackets.flatMap((entry): OverlayBracket[] => {
    const item = objectValue(entry);
    const min = finiteInteger(item.amountMinPaise, 1000, 1000, 1_000_000_000);
    const maxRaw = item.amountMaxPaise;
    const max = maxRaw === null ? null : finiteInteger(maxRaw, min, min, 1_000_000_000);
    return [{
      amountMinPaise: min,
      amountMaxPaise: max,
      charLimit: finiteInteger(item.charLimit, 120, 10, 500),
      displayStyle: validStyle(item.displayStyle, DEFAULT_CONFIG.defaultStyle),
      displayMinMs: finiteInteger(item.displayMinMs, 8000, 4000, 60000),
      ttsEligible: item.ttsEligible !== false,
      ttsOverflowPolicy: validOverflow(item.ttsOverflowPolicy, 'extend'),
    }];
  }) : DEFAULT_CONFIG.brackets;
  return {
    defaultDisplaySeconds: finiteInteger(source.defaultDisplaySeconds, DEFAULT_CONFIG.defaultDisplaySeconds, 4, 60),
    defaultStyle: validStyle(source.defaultStyle, DEFAULT_CONFIG.defaultStyle),
    locale: typeof source.locale === 'string' ? source.locale.slice(0, 16) : DEFAULT_CONFIG.locale,
    reducedMotion: source.reducedMotion === true,
    brackets: brackets.length > 0 ? brackets : DEFAULT_CONFIG.brackets,
    tts: { enabled: tts.enabled === true, paddingMs: finiteInteger(tts.paddingMs, 300, 0, 10000), overflowPolicy: validOverflow(tts.overflowPolicy, 'extend') },
    display: {
      anchor: validAnchor(display.anchor, DEFAULT_CONFIG.display.anchor),
      offsetX: finiteInteger(display.offsetX, 0, -10000, 10000),
      offsetY: finiteInteger(display.offsetY, 0, -10000, 10000),
      scale: finiteNumber(display.scale, 1, .5, 2),
      widthPercent: finiteInteger(display.widthPercent, 80, 10, 100),
      maxVisibleItems: finiteInteger(display.maxVisibleItems, 1, 1, 10),
    },
    queue: {
      mode: validMode(queue.mode, 'fifo'),
      stackLimit: finiteInteger(queue.stackLimit, 1, 1, 10),
      aggregationWindowSeconds: finiteInteger(queue.aggregationWindowSeconds, 30, 1, 300),
      aggregationThreshold: finiteInteger(queue.aggregationThreshold, 5, 2, 100),
    },
  };
}

function applyBracketOverride(item: OverlayItem, config: OverlayConfig, raw: unknown): OverlayConfig {
  const override = objectValue(raw);
  if (Object.keys(override).length === 0) return config;

  const amount = amountPaise(item);
  const selectedIndex = Math.max(0, config.brackets.findIndex((bracket) => (
    amount >= bracket.amountMinPaise
      && (bracket.amountMaxPaise === null || amount <= bracket.amountMaxPaise)
  )));
  const current = config.brackets[selectedIndex];
  if (!current) return config;

  const bracket: OverlayBracket = {
    ...current,
    charLimit: finiteInteger(override.charLimit, current.charLimit, 10, 500),
    displayStyle: validStyle(override.displayStyle, current.displayStyle),
    displayMinMs: finiteInteger(override.displayMinMs, current.displayMinMs, 4000, 60000),
    ttsEligible: typeof override.ttsEligible === 'boolean' ? override.ttsEligible : current.ttsEligible,
    ttsOverflowPolicy: validOverflow(override.ttsOverflowPolicy, current.ttsOverflowPolicy),
  };
  return { ...config, brackets: config.brackets.map((entry, index) => index === selectedIndex ? bracket : entry) };
}

/** Only approved, presentation-safe override keys are allowed to affect a delivery. */
export function configForItem(item: OverlayItem): OverlayConfig {
  const snapshot = objectValue(item.payload.configSnapshot);
  const override = objectValue(item.payload.overrideValues);
  const safeOverride: Record<string, unknown> = {};
  if (override.style !== undefined) safeOverride.defaultStyle = override.style;
  if (override.displayStyle !== undefined) safeOverride.defaultStyle = override.displayStyle;
  if (override.anchor !== undefined) safeOverride.display = { anchor: override.anchor };
  if (override.scale !== undefined) safeOverride.display = { ...(objectValue(safeOverride.display)), scale: override.scale };
  if (override.reducedMotion !== undefined) safeOverride.reducedMotion = override.reducedMotion;
  const config = normalizeOverlayConfig({ ...snapshot, ...safeOverride, display: { ...objectValue(snapshot.display), ...objectValue(safeOverride.display) } });
  return applyBracketOverride(item, config, override.bracket);
}

export function amountPaise(item: OverlayItem): number {
  const raw = item.payload.amountPaise;
  const value = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export function bracketFor(item: OverlayItem, config: OverlayConfig): OverlayBracket {
  const amount = amountPaise(item);
  return config.brackets.find((bracket) => amount >= bracket.amountMinPaise && (bracket.amountMaxPaise === null || amount <= bracket.amountMaxPaise)) ?? config.brackets[config.brackets.length - 1]!;
}

export function truncateMessage(value: unknown, limit: number): string {
  const text = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  const normalized = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

export function displayDurationMs(items: OverlayItem[], config: OverlayConfig): number {
  const duration = Math.max(...items.map((item) => bracketFor(item, config).displayMinMs), config.defaultDisplaySeconds * 1000);
  const audioDuration = items.reduce((max, item) => Math.max(max, Number(item.payload.ttsAudioDurationMs) || 0), 0);
  return Math.min(60000, Math.max(4000, duration, audioDuration + config.tts.paddingMs));
}

/**
 * TTS is an optional side effect. A missing/failed provider result must still
 * leave the visual delivery path active; the browser can use the chime branch
 * without waiting for or retrying a provider request.
 */
export function ttsPlaybackPlan(item: OverlayItem, config: OverlayConfig): TtsPlaybackPlan {
  const bracket = bracketFor(item, config);
  if (!config.tts.enabled || !bracket.ttsEligible || bracket.ttsOverflowPolicy === 'visual_only' || bracket.ttsOverflowPolicy === 'disable') {
    return { mode: 'silent' };
  }
  const candidate = item.payload.ttsAudioUrl;
  if (typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 512) {
    return { mode: 'audio', audioUrl: candidate };
  }
  return { mode: 'chime' };
}

function timestamp(item: OverlayItem): number {
  const parsed = item.createdAt ? Date.parse(item.createdAt) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

export function selectPresentationGroup(items: OverlayItem[], config: OverlayConfig): { group: OverlayItem[]; rest: OverlayItem[] } {
  if (items.length === 0) return { group: [], rest: [] };
  const ordered = [...items];
  if (config.queue.mode === 'aggregated' && ordered.length >= config.queue.aggregationThreshold) {
    const firstTime = timestamp(ordered[0]!);
    // Aggregation is one visual card, so maxVisibleItems must not reduce the
    // number of durable events represented by that card. The bounded threshold
    // keeps the card finite while every represented cursor is still acked.
    const aggregateLimit = Math.min(100, Math.max(config.queue.aggregationThreshold, config.display.maxVisibleItems));
    const aggregate = ordered.filter((item) => timestamp(item) - firstTime <= config.queue.aggregationWindowSeconds * 1000).slice(0, aggregateLimit);
    return { group: aggregate.length > 1 ? aggregate : [ordered[0]!], rest: ordered.filter((item) => !aggregate.includes(item)) };
  }
  // Select a contiguous FIFO frontier first. Priority may change the visual
  // order inside that frontier, but never selects a later cursor ahead of an
  // earlier one; reconnect cursors therefore cannot skip an unacknowledged
  // delivery after a crash.
  const count = Math.min(config.queue.mode === 'stacked' || config.queue.mode === 'pills' || config.queue.mode === 'priority' ? config.display.maxVisibleItems : 1, config.queue.stackLimit, ordered.length);
  const selected = ordered.slice(0, count);
  const group = config.queue.mode === 'priority'
    ? [...selected].sort((a, b) => (Number(b.payload.sourcePriority) || 0) - (Number(a.payload.sourcePriority) || 0) || (a.arrivalOrder ?? 0) - (b.arrivalOrder ?? 0))
    : selected;
  return { group, rest: ordered.filter((item) => !group.includes(item)) };
}

export function aggregateLabel(items: OverlayItem[]): string {
  const total = items.reduce((sum, item) => sum + amountPaise(item), 0);
  return `${items.length} supporters · ₹${(total / 100).toLocaleString('en-IN')}`;
}

/**
 * Restore only the acknowledgement suffix that was not confirmed by the
 * server. The already-acknowledged prefix must remain behind Last-Event-ID;
 * re-adding it would create a duplicate visual delivery after reconnect.
 */
export function requeueUnacknowledged(
  acknowledgementOrder: OverlayItem[],
  acknowledgedCount: number,
  rest: OverlayItem[],
): OverlayItem[] {
  const safeCount = Math.max(0, Math.min(acknowledgementOrder.length, Math.floor(acknowledgedCount)));
  return [...acknowledgementOrder.slice(safeCount), ...rest];
}
