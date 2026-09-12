import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeUserCode } from './pairing-client';

test('normalises case, spaces and dashes on an otherwise-valid code', () => {
  assert.equal(normalizeUserCode('abcd2345'), 'ABCD2345');
  assert.equal(normalizeUserCode(' abcd 2345 '), 'ABCD2345');
  assert.equal(normalizeUserCode('abcd-2345'), 'ABCD2345');
  assert.equal(normalizeUserCode('AB-CD-23-45'), 'ABCD2345');
});

test('rejects a code that is not exactly 8 characters after normalising', () => {
  assert.equal(normalizeUserCode('ABCD234'), null);
  assert.equal(normalizeUserCode('ABCD23456'), null);
  assert.equal(normalizeUserCode(''), null);
  assert.equal(normalizeUserCode('AB-CD-23'), null);
});

test('a typed 0 or 1 is remapped rather than rejected outright, but still fails validation because the real alphabet has no O or I either', () => {
  // 'ABCD234O' has a letter O in the 8th slot already, invalid either way.
  assert.equal(normalizeUserCode('ABCD2340'), null); // trailing 0 -> O, still not in the alphabet
  assert.equal(normalizeUserCode('ABCD2341'), null); // trailing 1 -> I, still not in the alphabet
});

test('rejects characters the real alphabet never contains', () => {
  assert.equal(normalizeUserCode('ABCDEFGO'), null); // letter O
  assert.equal(normalizeUserCode('ABCDEFGI'), null); // letter I
});

test('accepts every character the real alphabet does contain', () => {
  // A-H, J-N, P-Z, and 2-9 — one full pass to make sure nothing in the
  // valid set is accidentally rejected.
  assert.equal(normalizeUserCode('ABCDEFGH'), 'ABCDEFGH');
  assert.equal(normalizeUserCode('JKLMNPQR'), 'JKLMNPQR');
  assert.equal(normalizeUserCode('STUVWXYZ'), 'STUVWXYZ');
  assert.equal(normalizeUserCode('23456789'), '23456789');
});
