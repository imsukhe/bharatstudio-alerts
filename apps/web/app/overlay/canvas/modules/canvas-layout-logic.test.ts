import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CANVAS_LAYOUT_ARRANGED_MODULE_KEYS,
  canvasRootClassName,
  isCanvasLayout,
  isCanvasLayoutSnapshot,
  type CanvasLayoutSnapshot,
} from './canvas-layout-logic';

/*
 * §6 catalogue module #14 (Vertical Stream Layout) -- pure logic cases.
 *
 * The case that carries a recorded product decision, not a mechanical
 * requirement: CANVAS_LAYOUT_ARRANGED_MODULE_KEYS is exactly three keys
 * -- compact goal (community_goal_ladder), QR Smart Card, Reaction Cloud
 * -- and NEVER a chat module or a placeholder standing in for one (owner
 * decision, 2026-09-17, §6 #19).
 */

const horizontal: CanvasLayoutSnapshot = { schemaVersion: 'v1', layout: 'horizontal' };
const vertical: CanvasLayoutSnapshot = { schemaVersion: 'v1', layout: 'vertical' };

test('the arranged module list is exactly three keys -- compact goal, QR, reactions -- and never chat', () => {
  assert.deepEqual(CANVAS_LAYOUT_ARRANGED_MODULE_KEYS, ['community_goal_ladder', 'qr_smart_card', 'reaction_cloud']);
  assert.equal(CANVAS_LAYOUT_ARRANGED_MODULE_KEYS.length, 3);
  assert.equal((CANVAS_LAYOUT_ARRANGED_MODULE_KEYS as readonly string[]).includes('chat'), false);
});

test('isCanvasLayout accepts exactly horizontal and vertical', () => {
  assert.equal(isCanvasLayout('horizontal'), true);
  assert.equal(isCanvasLayout('vertical'), true);
  assert.equal(isCanvasLayout('square'), false);
  assert.equal(isCanvasLayout('9:16'), false);
  assert.equal(isCanvasLayout(null), false);
  assert.equal(isCanvasLayout(undefined), false);
  assert.equal(isCanvasLayout(42), false);
});

test('a valid horizontal or vertical snapshot is accepted', () => {
  assert.equal(isCanvasLayoutSnapshot(horizontal), true);
  assert.equal(isCanvasLayoutSnapshot(vertical), true);
});

test('null and non-object values are rejected', () => {
  assert.equal(isCanvasLayoutSnapshot(null), false);
  assert.equal(isCanvasLayoutSnapshot(undefined), false);
  assert.equal(isCanvasLayoutSnapshot('vertical'), false);
  assert.equal(isCanvasLayoutSnapshot(42), false);
  assert.equal(isCanvasLayoutSnapshot([]), false);
});

test('an unrecognised layout value is rejected -- no variant, no aspect ratio', () => {
  assert.equal(isCanvasLayoutSnapshot({ schemaVersion: 'v1', layout: 'square' }), false);
  assert.equal(isCanvasLayoutSnapshot({ schemaVersion: 'v1', layout: '9:16' }), false);
  assert.equal(isCanvasLayoutSnapshot({ schemaVersion: 'v1', layout: 'vertical-v2' }), false);
});

test('an extra field is rejected outright -- a variant id, a channel id, a scene id -- this setting holds no such concept', () => {
  assert.equal(isCanvasLayoutSnapshot({ schemaVersion: 'v1', layout: 'vertical', variantId: 'v2' }), false);
  assert.equal(isCanvasLayoutSnapshot({ schemaVersion: 'v1', layout: 'vertical', channelId: '00000000-0000-4000-8000-000000000011' }), false);
  assert.equal(isCanvasLayoutSnapshot({ schemaVersion: 'v1', layout: 'vertical', sceneId: '00000000-0000-4000-8000-0000000000ee' }), false);
});

test('a wrong schemaVersion is rejected', () => {
  assert.equal(isCanvasLayoutSnapshot({ schemaVersion: 'v2', layout: 'vertical' }), false);
});

test('canvasRootClassName adds the modifier class only for vertical, and never mutates the base class', () => {
  assert.equal(canvasRootClassName('horizontal'), 'master-canvas-root');
  assert.equal(canvasRootClassName('vertical'), 'master-canvas-root master-canvas-root--vertical');
});
