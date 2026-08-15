import test from 'node:test';
import assert from 'node:assert/strict';
import { hasReachedEntitlementLimit, parsePositiveEntitlementLimit } from '../src/domain/entitlement-limits.js';

test('queue entitlement limits parse safely and remain optional when absent', () => {
  assert.equal(parsePositiveEntitlementLimit(null, 'queue'), null);
  assert.equal(parsePositiveEntitlementLimit('', 'queue'), null);
  assert.equal(parsePositiveEntitlementLimit('16', 'queue'), 16);
  assert.equal(hasReachedEntitlementLimit(15, 16), false);
  assert.equal(hasReachedEntitlementLimit(16, 16), true);
});

test('invalid entitlement limits fail closed', () => {
  assert.throws(() => parsePositiveEntitlementLimit('0', 'queue'));
  assert.throws(() => parsePositiveEntitlementLimit('16.5', 'queue'));
  assert.throws(() => parsePositiveEntitlementLimit('not-a-number', 'queue'));
  assert.throws(() => hasReachedEntitlementLimit(-1, 16));
});
