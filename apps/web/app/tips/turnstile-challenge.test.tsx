import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { missingProductionTurnstileSiteKey, publicTurnstileSiteKey, TurnstileChallenge, turnstileScriptSrc } from './turnstile-challenge';

test('the public site-key helper never treats whitespace as a configured challenge', () => {
  assert.equal(publicTurnstileSiteKey('  site-key  '), 'site-key');
  assert.equal(publicTurnstileSiteKey('   '), undefined);
  assert.equal(publicTurnstileSiteKey('x'.repeat(2049)), undefined);
  assert.equal(missingProductionTurnstileSiteKey(undefined, 'production'), true);
  assert.equal(missingProductionTurnstileSiteKey(undefined, 'test'), false);
  assert.equal(missingProductionTurnstileSiteKey('site-key', 'production'), false);
});

test('the client adapter keeps an opaque response in memory, clears it on expiry, and resets it after an order attempt', async () => {
  let callbacks: { callback?: (token: string) => void; 'expired-callback'?: () => void; 'error-callback'?: () => void } | undefined;
  const resets: string[] = [];
  const removals: string[] = [];
  const previous = window.turnstile;
  window.turnstile = {
    render: (_container, options) => {
      callbacks = options;
      return 'widget-synthetic';
    },
    reset: (id) => resets.push(id),
    remove: (id) => removals.push(id),
  };
  const tokens: Array<string | null> = [];

  try {
    const rendered = render(<TurnstileChallenge siteKey="site-key" onToken={(token) => tokens.push(token)} resetNonce={0} />);
    await act(async () => {});
    assert.equal(document.querySelector(`script[src="${turnstileScriptSrc}"]`) !== null, true);
    await act(async () => { callbacks?.callback?.('opaque-response'); });
    await act(async () => { callbacks?.['expired-callback']?.(); });
    rendered.rerender(<TurnstileChallenge siteKey="site-key" onToken={(token) => tokens.push(token)} resetNonce={1} />);
    await act(async () => {});
    assert.deepEqual(tokens, ['opaque-response', null, null]);
    assert.deepEqual(resets, ['widget-synthetic']);
    assert.equal(window.sessionStorage.length, 0);
    assert.equal(window.localStorage.length, 0);
    assert.equal(screen.queryByText(/security check could not load/i), null);
    rendered.unmount();
    assert.deepEqual(removals, ['widget-synthetic']);
  } finally {
    window.turnstile = previous;
  }

});
