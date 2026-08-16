import assert from 'node:assert/strict';
import test from 'node:test';
import { computeIpSubnetHash } from '../src/domain/ip-subnet.js';

test('two IPv4 addresses in the same /24 hash identically, a different /24 hashes differently', () => {
  const a = computeIpSubnetHash('203.0.113.10');
  const b = computeIpSubnetHash('203.0.113.200');
  const c = computeIpSubnetHash('203.0.114.10');
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('an IPv4-mapped IPv6 address hashes the same as its plain IPv4 form', () => {
  const mapped = computeIpSubnetHash('::ffff:203.0.113.10');
  const plain = computeIpSubnetHash('203.0.113.10');
  assert.equal(mapped, plain);
});

test('IPv6 addresses sharing a leading /48-ish prefix hash identically, a different prefix hashes differently', () => {
  const a = computeIpSubnetHash('2001:db8:1234::1');
  const b = computeIpSubnetHash('2001:db8:1234::2');
  const c = computeIpSubnetHash('2001:db8:5678::1');
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('never returns a raw IP — the output is always a hex digest, and empty/invalid input returns null', () => {
  const hash = computeIpSubnetHash('203.0.113.10');
  assert.match(hash ?? '', /^[0-9a-f]{64}$/);
  assert.equal(computeIpSubnetHash(undefined), null);
  assert.equal(computeIpSubnetHash(null), null);
  assert.equal(computeIpSubnetHash(''), null);
  assert.equal(computeIpSubnetHash('not-an-ip'), null);
});
