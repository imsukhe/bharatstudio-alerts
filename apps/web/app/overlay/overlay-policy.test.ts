import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateLabel,
  bracketFor,
  configForItem,
  displayDurationMs,
  normalizeOverlayConfig,
  parseOverlayItem,
  requeueUnacknowledged,
  selectPresentationGroup,
  ttsPlaybackPlan,
  truncateMessage,
  type OverlayItem,
} from './overlay-policy';

const item = (cursor: string, amountPaise: number, priority = 0, createdAt = '2026-08-15T10:00:00.000Z'): OverlayItem => ({
  cursor,
  eventId: cursor,
  eventType: 'alert.ready',
  createdAt,
  arrivalOrder: Number(cursor),
  payload: { amountPaise, sourcePriority: priority, displayName: `User ${cursor}`, message: 'A long enough message for testing' },
});

test('normalizes invalid or untrusted configuration to bounded safe values', () => {
  const config = normalizeOverlayConfig({ defaultDisplaySeconds: 999, display: { scale: 99, anchor: 'javascript:' }, queue: { mode: 'unknown', stackLimit: -1 } });
  assert.equal(config.defaultDisplaySeconds, 8);
  assert.equal(config.display.scale, 1);
  assert.equal(config.display.anchor, 'bottom_center');
  assert.equal(config.queue.mode, 'fifo');
  assert.equal(config.queue.stackLimit, 1);
});

test('accepts only the versioned overlay event envelope', () => {
  const valid = parseOverlayItem({
    schemaVersion: 'v1',
    cursor: '2026-08-15T10:00:00.000000Z|00000000-0000-4000-8000-000000000001',
    eventId: '00000000-0000-4000-8000-000000000001',
    eventType: 'alert.ready',
    traceId: 'synthetic:overlay-event',
    createdAt: '2026-08-15T10:00:00.000Z',
    payload: { displayName: 'Viewer', message: 'Hello' },
  });
  assert.equal(valid?.eventId, '00000000-0000-4000-8000-000000000001');
  assert.equal(parseOverlayItem({ ...valid, schemaVersion: 'v2' }), null);
  assert.equal(parseOverlayItem({ ...valid, eventId: 'not-a-uuid' }), null);
  assert.equal(parseOverlayItem({ ...valid, payload: '<script>alert(1)</script>' }), null);
  assert.equal(parseOverlayItem({ ...valid, eventType: 'unknown.alert' }), null);
});

test('uses amount bracket style, character limit and minimum display duration', () => {
  const config = normalizeOverlayConfig({ defaultDisplaySeconds: 8, brackets: [
    { amountMinPaise: 1000, amountMaxPaise: 1999, charLimit: 10, displayStyle: 'small_pill', displayMinMs: 4000, ttsEligible: false, ttsOverflowPolicy: 'disable' },
    { amountMinPaise: 2000, amountMaxPaise: null, charLimit: 40, displayStyle: 'celebration', displayMinMs: 12000, ttsEligible: true, ttsOverflowPolicy: 'extend' },
  ] });
  const low = item('1', 1500);
  const high = item('2', 2500);
  assert.equal(bracketFor(low, config).displayStyle, 'small_pill');
  assert.equal(bracketFor(high, config).displayStyle, 'celebration');
  assert.equal(displayDurationMs([high], config), 12000);
  assert.equal(truncateMessage(low.payload.message, 10), 'A long en…');
});

test('supports stacked, pills, priority and aggregate grouping without dropping the remainder', () => {
  const items = [item('1', 1000, 10), item('2', 2000, 90), item('3', 3000, 20)];
  const stacked = selectPresentationGroup(items, normalizeOverlayConfig({ queue: { mode: 'stacked', stackLimit: 2 }, display: { maxVisibleItems: 2 } }));
  assert.equal(stacked.group.length, 2);
  assert.equal(stacked.rest.length, 1);
  const priority = selectPresentationGroup(items, normalizeOverlayConfig({ queue: { mode: 'priority', stackLimit: 2 }, display: { maxVisibleItems: 2 } }));
  assert.equal(priority.group[0]?.cursor, '2');
  assert.equal(priority.group.length, 2);
  assert.equal(priority.rest.length, 1);
  const aggregate = selectPresentationGroup(items, normalizeOverlayConfig({ queue: { mode: 'aggregated', aggregationThreshold: 2, aggregationWindowSeconds: 30 }, display: { maxVisibleItems: 10 } }));
  assert.equal(aggregate.group.length, 3);
  assert.equal(aggregateLabel(aggregate.group), '3 supporters · ₹60');
});

test('only approved override fields affect a delivery configuration', () => {
  const configured = configForItem({ ...item('1', 1000), payload: { configSnapshot: { defaultStyle: 'celebration', display: { scale: 1.2 } }, overrideValues: { displayStyle: 'small_pill', script: '<script>alert(1)</script>' } } });
  assert.equal(configured.defaultStyle, 'small_pill');
  assert.equal(configured.display.scale, 1.2);
});

test('applies only bounded per-bracket overrides without changing amount routing', () => {
  const configured = configForItem({
    ...item('1', 2500),
    payload: {
      ...item('1', 2500).payload,
      configSnapshot: {
        brackets: [
          { amountMinPaise: 1000, amountMaxPaise: 1999, charLimit: 40, displayStyle: 'small_pill', displayMinMs: 8000, ttsEligible: true, ttsOverflowPolicy: 'extend' },
          { amountMinPaise: 2000, amountMaxPaise: null, charLimit: 120, displayStyle: 'standard_card', displayMinMs: 8000, ttsEligible: true, ttsOverflowPolicy: 'extend' },
        ],
      },
      overrideValues: {
        bracket: { charLimit: 22, displayMinMs: 14000, displayStyle: 'large_card', ttsEligible: false, ttsOverflowPolicy: 'disable', amountMinPaise: 1 },
      },
    },
  });
  const bracket = bracketFor(item('1', 2500), configured);
  assert.equal(bracket.charLimit, 22);
  assert.equal(bracket.displayMinMs, 14000);
  assert.equal(bracket.displayStyle, 'large_card');
  assert.equal(bracket.ttsEligible, false);
  assert.equal(bracket.ttsOverflowPolicy, 'disable');
  assert.equal(bracket.amountMinPaise, 2000);
});

test('TTS is an optional side effect with a non-blocking chime fallback', () => {
  const configured = normalizeOverlayConfig({ tts: { enabled: true }, brackets: [{ amountMinPaise: 1000, amountMaxPaise: null, charLimit: 120, displayStyle: 'standard_card', displayMinMs: 8000, ttsEligible: true, ttsOverflowPolicy: 'extend' }] });
  assert.deepEqual(ttsPlaybackPlan(item('1', 1000), configured), { mode: 'chime' });
  assert.deepEqual(ttsPlaybackPlan({ ...item('2', 1000), payload: { ...item('2', 1000).payload, ttsAudioUrl: '/v1/overlay-audio/synthetic' } }, configured), { mode: 'audio', audioUrl: '/v1/overlay-audio/synthetic' });
  assert.deepEqual(ttsPlaybackPlan(item('3', 1000), normalizeOverlayConfig({ tts: { enabled: false } })), { mode: 'silent' });
});

test('requeues only the unacknowledged suffix for reconnect replay', () => {
  const acknowledgementOrder = [item('1', 1000), item('2', 1000), item('3', 1000)];
  const rest = [item('4', 1000)];
  const requeued = requeueUnacknowledged(acknowledgementOrder, 1, rest);
  assert.deepEqual(requeued.map((entry) => entry.cursor), ['2', '3', '4']);
});
