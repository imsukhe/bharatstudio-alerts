import assert from 'node:assert/strict';
import test from 'node:test';
import { detectPii } from '../src/domain/pii-detection.js';

/*
 * SAF-12 (packages/db/migrations/0154). Pure, DB-free tests of the
 * detector itself, INCLUDING the structural "never persisted" proof at
 * the TypeScript layer (the database-side half of that same proof --
 * safety_pii_detections has no text/value column at all -- is in
 * packages/db/tests/saf_url_ssml_pii.sql).
 */

test('SAF-12: detects a phone number by class only', () => {
  const result = detectPii('call me on 9876543210 after the stream');
  assert.deepEqual(result.classes, ['phone']);
});

test('SAF-12: detects a UPI id, distinct from an email', () => {
  const upi = detectPii('send it to 9876543210@okhdfcbank please');
  assert.ok(upi.classes.includes('upi_id'));
  assert.ok(!upi.classes.includes('email'));

  const email = detectPii('reach me at creator@example.com anytime');
  assert.ok(email.classes.includes('email'));
  assert.ok(!email.classes.includes('upi_id'));
});

test('SAF-12: detects a card-like digit run', () => {
  const result = detectPii('my card is 4111 1111 1111 1111 do not share');
  assert.ok(result.classes.includes('card_like'));
});

test('SAF-12: detects an Indian PIN code as the narrow "address" proxy', () => {
  const result = detectPii('ship it to 400001 mumbai');
  assert.ok(result.classes.includes('address_pin_code'));
});

test('SAF-12: a clean message with none of the five shapes detects nothing', () => {
  const result = detectPii('thanks so much for the tip, love the stream');
  assert.deepEqual(result.classes, []);
});

test('SAF-12: a message with multiple PII classes reports all of them, deduplicated', () => {
  const result = detectPii('call 9876543210 or email creator@example.com, pin 400001');
  assert.deepEqual(result.classes.sort(), ['address_pin_code', 'email', 'phone'].sort());
});

test('SAF-12: resists zero-width-character evasion via the ONE shared normalizeForSafetyMatching call (SAF-01)', () => {
  // Zero-width space injected inside the digit run.
  const evasive = 'call 987​6543210 now';
  const result = detectPii(evasive);
  assert.ok(result.classes.includes('phone'), 'zero-width-character evasion inside a phone number must still be detected');
});

// -----------------------------------------------------------------------
// STRUCTURAL PROOF: detectPii's return type, and therefore every value it
// can ever produce, is incapable of carrying the matched substring.
// -----------------------------------------------------------------------

test('SAF-12/S12.10: the detection result never contains the matched value -- proven for every class, not asserted only in prose', () => {
  const phoneNumber = '9876543210';
  const upiId = 'sukhdev@okaxis';
  const email = 'sukhdevsingh@example.com';
  const cardNumber = '4111111111111111';
  const pinCode = '400001';

  const cases: Array<{ text: string; secret: string }> = [
    { text: `call me on ${phoneNumber} anytime`, secret: phoneNumber },
    { text: `pay to ${upiId} thanks`, secret: upiId },
    { text: `reach me at ${email}`, secret: email },
    { text: `card ${cardNumber} expires soon`, secret: cardNumber },
    { text: `deliver to pin ${pinCode}`, secret: pinCode },
  ];

  for (const { text, secret } of cases) {
    const result = detectPii(text);
    assert.ok(result.classes.length >= 1, `expected at least one class for: ${text}`);
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(secret), `detection result for "${text}" must never serialize the matched value "${secret}", got: ${serialized}`);
  }
});

test('SAF-12: PiiDetectionResult has exactly one field, "classes", shaped as an array of the five fixed class names -- structurally, there is nowhere else on this type to put a value', () => {
  const result = detectPii('9876543210');
  assert.deepEqual(Object.keys(result), ['classes']);
  const allowedClasses = ['phone', 'upi_id', 'email', 'address_pin_code', 'card_like'];
  for (const c of result.classes) assert.ok(allowedClasses.includes(c));
});
