import assert from 'node:assert/strict';
import test from 'node:test';
import { ACTION_CATALOGUE, buildTargetLabel, decodeSceneAndItem, encodeSceneAndItem, nextFreeSlotIndex } from './action-catalogue';

test('catalogue has exactly the 17 L24 actions, one entry each', () => {
  assert.equal(ACTION_CATALOGUE.length, 17);
  assert.equal(new Set(ACTION_CATALOGUE.map((entry) => entry.action)).size, 17);
});

test('encodeSceneAndItem / decodeSceneAndItem round-trip', () => {
  const label = encodeSceneAndItem('Main Scene', 12);
  assert.equal(label, 'Main Scene#12');
  assert.deepEqual(decodeSceneAndItem(label as string), { sceneName: 'Main Scene', sceneItemId: 12 });
});

test('encodeSceneAndItem rejects a scene name that already contains the delimiter', () => {
  assert.equal(encodeSceneAndItem('Main#Scene', 1), null);
});

test('encodeSceneAndItem rejects a non-positive or non-integer scene item id', () => {
  assert.equal(encodeSceneAndItem('Main Scene', 0), null);
  assert.equal(encodeSceneAndItem('Main Scene', 1.5), null);
});

test('buildTargetLabel returns null for queue/none targets regardless of input', () => {
  assert.equal(buildTargetLabel('queue', { text: 'anything' }), null);
  assert.equal(buildTargetLabel('none', { text: 'anything' }), null);
});

test('buildTargetLabel requires bounded printable text for single-field targets', () => {
  assert.equal(buildTargetLabel('sceneName', {}), null);
  assert.equal(buildTargetLabel('sceneName', { text: '' }), null);
  assert.equal(buildTargetLabel('sceneName', { text: 'a'.repeat(201) }), null);
  assert.equal(buildTargetLabel('sceneName', { text: '  Main Scene  ' }), 'Main Scene');
});

test('buildTargetLabel composes sceneAndItem only when both fields are valid', () => {
  assert.equal(buildTargetLabel('sceneAndItem', { text: 'Main Scene' }), null);
  assert.equal(buildTargetLabel('sceneAndItem', { text: 'Main Scene', sceneItemId: '0' }), null);
  assert.equal(buildTargetLabel('sceneAndItem', { text: 'Main Scene', sceneItemId: '12' }), 'Main Scene#12');
});

test('nextFreeSlotIndex finds the first unused index within the tier ladder', () => {
  assert.equal(nextFreeSlotIndex(8, []), 1);
  assert.equal(nextFreeSlotIndex(8, [1, 2, 3]), 4);
  assert.equal(nextFreeSlotIndex(8, [1, 3]), 2);
  assert.equal(nextFreeSlotIndex(2, [1, 2]), null);
});
