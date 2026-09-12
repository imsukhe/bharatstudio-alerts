import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePublicChannel } from './public-channel-contract';

const channelId = '00000000-0000-4000-8000-000000000011';
const base = { channelId, handle: 'current_handle', displayName: 'Demo Creator', acceptingTips: true, minimumTipPaise: 1000, publicConfigVersion: 1 };

test('accepts renamedFrom carrying the originally-requested handle', () => {
  const parsed = parsePublicChannel({ ...base, renamedFrom: 'old_handle' });
  assert.equal(parsed?.renamedFrom, 'old_handle');
  assert.equal(parsed?.handle, 'current_handle');
});

test('omits renamedFrom entirely on a plain (non-renamed) response', () => {
  const parsed = parsePublicChannel(base);
  assert.equal(parsed && 'renamedFrom' in parsed, false);
});

test('rejects a malformed renamedFrom rather than passing it through', () => {
  assert.equal(parsePublicChannel({ ...base, renamedFrom: 'bad handle with spaces' }), null);
  assert.equal(parsePublicChannel({ ...base, renamedFrom: 123 }), null);
});
