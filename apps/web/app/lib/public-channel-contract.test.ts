import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePublicChannel } from './public-channel-contract';

const channelId = '00000000-0000-4000-8000-000000000011';

test('accepts the narrow public channel projection', () => {
  const parsed = parsePublicChannel({ channelId, handle: 'demo_creator', displayName: 'Demo Creator', acceptingTips: true, minimumTipPaise: 1000, publicConfigVersion: 1 });
  assert.equal(parsed?.minimumTipPaise, 1000);
  assert.equal(parsePublicChannel({ channelId, handle: 'demo_creator', displayName: 'Demo Creator', acceptingTips: true, minimumTipPaise: 999, publicConfigVersion: 1 }), null);
  assert.equal(parsePublicChannel({ channelId, handle: 'demo creator', displayName: 'Demo Creator', acceptingTips: true, minimumTipPaise: 1000, publicConfigVersion: 1 }), null);
  assert.equal(parsePublicChannel({ channelId, handle: 'demo_creator', displayName: ' ', acceptingTips: true, minimumTipPaise: 1000, publicConfigVersion: 1 }), null);
  assert.equal(parsePublicChannel({ channelId, handle: 'demo_creator', displayName: 'Demo Creator', acceptingTips: true, minimumTipPaise: 1000, publicConfigVersion: 1, internalSecret: 'should-not-cross' }), null);
});
