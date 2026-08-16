import assert from 'node:assert/strict';
import test from 'node:test';
import { validateLottieDocument } from '../src/domain/lottie-validation.js';

const minimalValid = { v: '5.7.4', layers: [] };

test('accepts a minimal well-formed Lottie document', () => {
  assert.deepEqual(validateLottieDocument(minimalValid), { ok: true });
  assert.deepEqual(validateLottieDocument({ v: 5, layers: [] }), { ok: true });
});

test('rejects a non-object, an array, missing "v", and missing "layers"', () => {
  assert.equal(validateLottieDocument('not an object').ok, false);
  assert.equal(validateLottieDocument([1, 2, 3]).ok, false);
  assert.equal(validateLottieDocument(null).ok, false);
  assert.equal(validateLottieDocument({ layers: [] }).ok, false);
  assert.equal(validateLottieDocument({ v: '5.0', layers: 'not-an-array' }).ok, false);
});

test('rejects a non-empty embedded expression anywhere in the document', () => {
  const result = validateLottieDocument({ v: '5.0', layers: [{ ks: { p: { expr: 'window.location' } } }] });
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.reason, /expression/);
});

test('allows an empty expression field but rejects a non-empty external asset URL', () => {
  assert.equal(validateLottieDocument({ v: '5.0', layers: [{ ks: { expr: '' } }] }).ok, true);
  const result = validateLottieDocument({ v: '5.0', layers: [], assets: [{ id: 'img_0', u: 'https://attacker.example/', p: 'logo.png' }] });
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.reason, /external asset/);
});

test('allows an asset embedded as a data URI', () => {
  const result = validateLottieDocument({ v: '5.0', layers: [], assets: [{ id: 'img_0', u: '', p: 'data:image/png;base64,AAAA' }] });
  assert.equal(result.ok, true);
});

test('rejects embedded script-looking string content anywhere in the tree', () => {
  const result = validateLottieDocument({ v: '5.0', layers: [], nm: '<script>alert(1)</script>' });
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.reason, /script/);
});

test('rejects a document nested deeper than the walk bound rather than crashing', () => {
  let deep: unknown = { v: 1 };
  for (let i = 0; i < 100; i += 1) deep = { nested: deep };
  const result = validateLottieDocument({ v: '5.0', layers: [deep] });
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.reason, /nested too deeply/);
});
