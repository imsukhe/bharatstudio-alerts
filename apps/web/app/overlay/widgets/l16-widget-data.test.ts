import test from 'node:test';
import assert from 'node:assert/strict';
import { isMegaTip, isRecentTips, isSupporterTicker, isTopSupporters } from './l16-widget-data';

test('L16 widget route payload guards reject malformed and privacy-expanding data', () => {
  assert.equal(isRecentTips([{ displayName: 'A', amountPaise: 100, message: null, createdAt: '2026-09-08T00:00:00Z' }]), true);
  assert.equal(isRecentTips([{ displayName: 'A', amountPaise: '100', message: null, createdAt: 'x' }]), false);
  assert.equal(isTopSupporters([{ rank: 1, viewerRef: 'viewer_1', tierLabel: 'gold' }]), true);
  assert.equal(isTopSupporters([{ rank: 1, viewerRef: 'viewer_1', tierLabel: 'gold', amountPaise: 99 }]), false);
  assert.equal(isSupporterTicker([{ viewerRef: 'viewer_1', tierLabel: 'gold', supportedAt: '2026-09-08T00:00:00Z' }]), true);
  assert.equal(isMegaTip({ displayName: 'A', amountPaise: 500000, createdAt: '2026-09-08T00:00:00Z' }), true);
  assert.equal(isMegaTip({ displayName: 'A', amountPaise: '500000', createdAt: 'x' }), false);
});
