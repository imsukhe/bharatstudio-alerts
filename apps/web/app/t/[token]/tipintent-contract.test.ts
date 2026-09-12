import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTipIntentResponse } from './tipintent-contract';

const ready = {
  schemaVersion: 'v1', state: 'ready', channelHandle: 'raka_gaming', channelDisplayName: 'Raka Gaming',
  amountPaise: 10000, currency: 'INR', donorDisplayName: 'Rahul', message: 'play GTA bhai',
};

test('parses a ready TipIntent with the full detail set', () => {
  assert.deepEqual(parseTipIntentResponse(ready), {
    state: 'ready', channelHandle: 'raka_gaming', channelDisplayName: 'Raka Gaming',
    amountPaise: 10000, currency: 'INR', donorDisplayName: 'Rahul', message: 'play GTA bhai',
  });
});

test('parses used/expired with channel identity only — no amount/name/message field at all', () => {
  const used = { schemaVersion: 'v1', state: 'used', channelHandle: 'raka_gaming', channelDisplayName: 'Raka Gaming' };
  assert.deepEqual(parseTipIntentResponse(used), { state: 'used', channelHandle: 'raka_gaming', channelDisplayName: 'Raka Gaming' });

  // A tampered/buggy server response smuggling amount alongside 'used' is
  // rejected outright (extra key), never silently accepted and displayed.
  const tampered = { ...used, amountPaise: 99999 };
  assert.equal(parseTipIntentResponse(tampered), null);
});

test('parses unknown with no channel identity leaked', () => {
  assert.deepEqual(parseTipIntentResponse({ schemaVersion: 'v1', state: 'unknown' }), { state: 'unknown' });
});

test('rejects a malformed or tampered ready response rather than partially trusting it', () => {
  assert.equal(parseTipIntentResponse({ ...ready, amountPaise: '10000' }), null); // wrong type
  assert.equal(parseTipIntentResponse({ ...ready, currency: 'USD' }), null); // wrong currency
  assert.equal(parseTipIntentResponse({ ...ready, extraField: 'x' }), null); // unexpected key
  assert.equal(parseTipIntentResponse({ ...ready, state: 'bogus' }), null); // unknown state value
  assert.equal(parseTipIntentResponse(null), null);
  assert.equal(parseTipIntentResponse('not-an-object'), null);
});
