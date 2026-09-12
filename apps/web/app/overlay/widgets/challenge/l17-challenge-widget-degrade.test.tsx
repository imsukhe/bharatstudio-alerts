import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act, render, screen } from '@testing-library/react';

/*
 * This is a browser-source widget polled by OBS on a live stream — a
 * thrown error here is dead air, not a stack trace anyone sees. Mirrors
 * ../goal/goal-widget-degrade.test.tsx's exact coverage: a network
 * failure mid-poll, and a malformed/garbage `challenge` payload from the
 * server, both must degrade to the empty state, never throw.
 */
mock.module('next/navigation', {
  namedExports: { useParams: () => ({ overlayId: 'ov1' }) },
});
mock.module(new URL('../../../lib/api-origin.ts', import.meta.url).pathname, {
  namedExports: { getApiOrigin: () => 'https://api.example.test' },
});

function setHashToken(token: string) {
  window.location.hash = `#token=${token}`;
}

async function renderFreshWidget() {
  const { default: ChallengeWidgetPage } = await import(`./[overlayId]/page.tsx?t=${Math.random()}`);
  render(<ChallengeWidgetPage />);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

test('a network failure mid-poll does not throw — the widget renders its quiet empty state', async () => {
  setHashToken('overlay-token-dddddddddddddddddddddddddddddddd');
  mock.method(globalThis, 'fetch', async () => { throw new TypeError('network error'); });
  await renderFreshWidget();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(screen.queryByRole('status'), null);
  assert.equal(screen.queryByText(/error/i), null);
  mock.reset();
});

test('a malformed challenge payload (fails isOverlayChallenge) is treated as no challenge, not rendered or thrown', async () => {
  setHashToken('overlay-token-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
  mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({ challenge: { title: 'missing required fields' } }) }));
  await renderFreshWidget();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(screen.queryByRole('status'), null);
  assert.equal(screen.queryByText('missing required fields'), null);
  mock.reset();
});

test('an unrecognised state string (fails isOverlayChallenge) is treated as no challenge, not rendered or thrown', async () => {
  setHashToken('overlay-token-ffffffffffffffffffffffffffffffff');
  const garbage = { schemaVersion: 'v1', challengeId: 'c1', title: 'X', kind: 'stake', targetAmountPaise: 1000, state: 'in_escrow', progressPaise: 0, targetReached: false };
  mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({ challenge: garbage }) }));
  await renderFreshWidget();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(screen.queryByRole('status'), null);
  mock.reset();
});

test('a 401 as the very first poll response never renders a challenge', async () => {
  setHashToken('overlay-token-gggggggggggggggggggggggggggggggg');
  mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 401, json: async () => ({}) }));
  await renderFreshWidget();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(screen.queryByRole('status'), null);
  mock.reset();
});
