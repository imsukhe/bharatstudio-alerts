import assert from 'node:assert/strict';
import test from 'node:test';
import { formatHistoryCursor, parseHistoryCursor } from '../src/db/history-cursor.js';

const eventId = '00000000-0000-4000-8000-000000000212';

test('history cursor round-trips timestamp and event-id tie-breaker', () => {
  const cursor = formatHistoryCursor(new Date('2026-08-14T10:00:00.000Z'), eventId);
  assert.equal(cursor, `2026-08-14T10:00:00.000Z|${eventId}`);
  assert.deepEqual(parseHistoryCursor(cursor), { createdAt: '2026-08-14T10:00:00.000Z', eventId });
});

test('history cursor keeps legacy timestamp-only cursors readable', () => {
  assert.deepEqual(parseHistoryCursor('2026-08-14T10:00:00.000Z'), { createdAt: '2026-08-14T10:00:00.000Z', eventId: null });
});

test('history cursor rejects malformed or ambiguous values', () => {
  assert.equal(parseHistoryCursor('2026-08-14T10:00:00.000Z|not-a-uuid'), undefined);
  assert.equal(parseHistoryCursor('2026-08-14T10:00:00.000Z|00000000-0000-4000-8000-000000000212|extra'), undefined);
  assert.equal(parseHistoryCursor('not-a-date|00000000-0000-4000-8000-000000000212'), undefined);
});
