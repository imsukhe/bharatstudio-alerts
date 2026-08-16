import assert from 'node:assert/strict';
import test from 'node:test';
import { validateConfigEntitlement } from '../src/domain/entitlement-policy.js';

test('server entitlement policy rejects only explicitly disallowed config features', () => {
  const config = { queue: { mode: 'priority', approvalRequired: true }, tts: { enabled: true }, display: { maxVisibleItems: 4 }, brackets: [{ charLimit: 200, displayMinMs: 20_000 }] };
  const issues = validateConfigEntitlement(config, { configFeatures: { allowedQueueModes: ['fifo'], approvalRequired: false, ttsEnabled: false, maxVisibleItems: 2, maxCharLimit: 120, maxDisplayMs: 10_000 } });
  assert.deepEqual(issues.map((issue) => issue.code), ['ERR_ENTITLEMENT_QUEUE_MODE', 'ERR_ENTITLEMENT_VISIBLE_ITEMS', 'ERR_ENTITLEMENT_CHAR_LIMIT', 'ERR_ENTITLEMENT_TTS', 'ERR_ENTITLEMENT_APPROVAL', 'ERR_ENTITLEMENT_DISPLAY_TIME']);
});

test('missing feature matrix remains backward compatible and does not invent a user restriction', () => {
  assert.deepEqual(validateConfigEntitlement({ queue: { mode: 'priority' }, tts: { enabled: true } }, {}), []);
});
