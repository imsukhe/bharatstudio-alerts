import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOverlayConfig, type OverlayItem } from '../overlay-policy';
import { browserTtsFallback, cancelBrowserTts, shouldShowWatermark, speakWithBrowserTts } from './tts-fallback';

function item(payload: Record<string, unknown>): OverlayItem {
  return { cursor: 'c1', eventId: '00000000-0000-4000-8000-000000000001', eventType: 'alert.ready', payload };
}

const ttsOnConfig = normalizeOverlayConfig({
  tts: { enabled: true },
  brackets: [{ amountMinPaise: 1000, amountMaxPaise: null, charLimit: 80, ttsEligible: true }],
});

test('browser TTS fallback engages for tier_not_entitled and never when a provider audio URL is already present', () => {
  const denied = item({ message: 'Namaste from a free creator', amountPaise: 5000, ttsFallbackReason: 'tier_not_entitled' });
  const plan = browserTtsFallback(denied, ttsOnConfig, false);
  assert.equal(plan.engage, true);
  if (plan.engage) {
    assert.equal(plan.text, 'Namaste from a free creator');
    assert.equal(plan.locale, ttsOnConfig.locale);
  }

  // Even with the same fallback reason present, an item that already has a
  // provider audio URL must never also engage the browser voice.
  const alreadyHasAudio = browserTtsFallback(denied, ttsOnConfig, true);
  assert.equal(alreadyHasAudio.engage, false);
});

test('browser TTS fallback engages for quota_exhausted', () => {
  const denied = item({ message: 'Thanks for the huge tip', amountPaise: 600000, ttsFallbackReason: 'quota_exhausted' });
  const plan = browserTtsFallback(denied, ttsOnConfig, false);
  assert.equal(plan.engage, true);
});

test('browser TTS fallback never engages without a recognized fallback reason', () => {
  const plain = item({ message: 'No fallback reason here', amountPaise: 5000 });
  assert.equal(browserTtsFallback(plain, ttsOnConfig, false).engage, false);

  const bogusReason = item({ message: 'Bogus reason', amountPaise: 5000, ttsFallbackReason: 'not_eligible' });
  assert.equal(browserTtsFallback(bogusReason, ttsOnConfig, false).engage, false);
});

test('browser TTS fallback respects the bracket/config gate (tts disabled or bracket ineligible)', () => {
  const ttsOffConfig = normalizeOverlayConfig({ tts: { enabled: false } });
  const denied = item({ message: 'Namaste', amountPaise: 5000, ttsFallbackReason: 'tier_not_entitled' });
  assert.equal(browserTtsFallback(denied, ttsOffConfig, false).engage, false);

  const ineligibleBracketConfig = normalizeOverlayConfig({
    tts: { enabled: true },
    brackets: [{ amountMinPaise: 1000, amountMaxPaise: null, charLimit: 80, ttsEligible: false }],
  });
  assert.equal(browserTtsFallback(denied, ineligibleBracketConfig, false).engage, false);
});

test('watermark shows only when the server marked the delivery watermark: true', () => {
  assert.equal(shouldShowWatermark(item({ watermark: true })), true);
  assert.equal(shouldShowWatermark(item({ watermark: false })), false);
  assert.equal(shouldShowWatermark(item({})), false);
});

test('speakWithBrowserTts degrades to a silent no-op when the Web Speech API is unavailable', () => {
  const original = (globalThis as { window?: unknown }).window;
  // Simulate a browser overlay window with no speechSynthesis at all.
  (globalThis as { window?: unknown }).window = {};
  assert.doesNotThrow(() => speakWithBrowserTts('hello', 'en-IN'));
  assert.doesNotThrow(() => cancelBrowserTts());
  (globalThis as { window?: unknown }).window = original;
});

test('speakWithBrowserTts speaks through a present Web Speech API and cancels any prior utterance first', () => {
  const original = (globalThis as { window?: unknown }).window;
  const spoken: string[] = [];
  let cancelled = 0;
  class FakeUtterance {
    lang = '';
    constructor(public text: string) {}
  }
  (globalThis as { window?: unknown }).window = {
    speechSynthesis: {
      speak(utterance: FakeUtterance) { spoken.push(utterance.text); },
      cancel() { cancelled += 1; },
    },
    SpeechSynthesisUtterance: FakeUtterance,
  };
  speakWithBrowserTts('read this aloud', 'hi-IN');
  assert.deepEqual(spoken, ['read this aloud']);
  assert.equal(cancelled, 1);
  cancelBrowserTts();
  assert.equal(cancelled, 2);
  (globalThis as { window?: unknown }).window = original;
});

test('speakWithBrowserTts degrades silently even if the Web Speech API throws', () => {
  const original = (globalThis as { window?: unknown }).window;
  class ThrowingUtterance {
    constructor() { throw new Error('boom'); }
  }
  (globalThis as { window?: unknown }).window = {
    speechSynthesis: { speak() {}, cancel() {} },
    SpeechSynthesisUtterance: ThrowingUtterance,
  };
  assert.doesNotThrow(() => speakWithBrowserTts('hello', 'en-IN'));
  (globalThis as { window?: unknown }).window = original;
});
