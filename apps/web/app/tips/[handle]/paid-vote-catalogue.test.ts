import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePublicPaidVoteCatalogue } from './paid-vote-catalogue';

const definitionId = '00000000-0000-4000-8000-000000000091';

test('accepts only the exact bounded public paid-vote catalogue contract', () => {
  const parsed = parsePublicPaidVoteCatalogue({
    schemaVersion: 'v1',
    items: [{ definitionId, label: 'Choose a game', options: [{ optionKey: 'game_a', label: 'Game A' }] }],
  });
  assert.deepEqual(parsed, [{ definitionId, label: 'Choose a game', options: [{ optionKey: 'game_a', label: 'Game A' }] }]);
});

test('rejects malformed, surplus, duplicate, oversized and private-looking catalogue data', () => {
  const valid = { definitionId, label: 'Choose a game', options: [{ optionKey: 'game_a', label: 'Game A' }] };
  assert.equal(parsePublicPaidVoteCatalogue({ schemaVersion: 'v1', items: [{ ...valid, queueId: 'private' }] }), null);
  assert.equal(parsePublicPaidVoteCatalogue({ schemaVersion: 'v1', items: [{ ...valid, options: [{ optionKey: 'game_a', label: 'A' }, { optionKey: 'game_a', label: 'B' }] }] }), null);
  assert.equal(parsePublicPaidVoteCatalogue({ schemaVersion: 'v1', items: [valid, valid] }), null);
  assert.equal(parsePublicPaidVoteCatalogue({ schemaVersion: 'v1', items: Array.from({ length: 9 }, () => valid) }), null);
  assert.equal(parsePublicPaidVoteCatalogue({ schemaVersion: 'v1', items: [{ ...valid, options: [] }] }), null);
});
