import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act, render, screen, waitFor } from '@testing-library/react';
import { CHALLENGE_FAILURE_COPY } from './challenge-widget-logic';

// The widget page reads the overlay id via next/navigation's useParams()
// and the session token from the URL hash fragment — mirrors
// ../goal/goal-widget-page.test.tsx's exact harness (see
// test-support/README.md).
mock.module('next/navigation', {
  namedExports: { useParams: () => ({ overlayId: 'ov1' }) },
});
mock.module(new URL('../../../lib/api-origin.ts', import.meta.url).pathname, {
  namedExports: { getApiOrigin: () => 'https://api.example.test' },
});

function setHashToken(token: string | null) {
  window.location.hash = token ? `#token=${token}` : '';
}

function baseChallenge(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'v1', challengeId: 'c1', title: 'Shave my head at target', kind: 'stake',
    targetAmountPaise: 1_000_000, state: 'active', progressPaise: 250_000, targetReached: false, ...overrides,
  };
}

async function renderFreshWidget() {
  const { default: ChallengeWidgetPage } = await import(`./[overlayId]/page.tsx?t=${Math.random()}`);
  render(<ChallengeWidgetPage />);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

test('with no bearer token in the hash, the widget renders nothing visible and makes no request', async () => {
  setHashToken(null);
  let called = false;
  mock.method(globalThis, 'fetch', async () => { called = true; throw new Error('must not be called'); });
  await renderFreshWidget();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(called, false);
  assert.equal(screen.queryByRole('status'), null);
  mock.reset();
});

test('with no live challenge (challenge: null), the widget renders its empty state, not an error', async () => {
  setHashToken('overlay-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({ challenge: null }) }));
  await renderFreshWidget();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(screen.queryByRole('status'), null);
  mock.reset();
});

test('a draft challenge never renders on stream even though the API returned it', async () => {
  setHashToken('overlay-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  const challenge = baseChallenge({ state: 'draft', progressPaise: 0 });
  mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({ challenge }) }));
  await renderFreshWidget();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(screen.queryByRole('status'), null);
  assert.equal(screen.queryByText('Shave my head at target'), null);
  mock.reset();
});

test('an active challenge shows title, amounts and progress, with no failure copy', async () => {
  setHashToken('overlay-token-cccccccccccccccccccccccccccccccc');
  const challenge = baseChallenge({ state: 'active', progressPaise: 250_000 });
  mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({ challenge }) }));
  await renderFreshWidget();
  await waitFor(() => screen.getByText('Shave my head at target'));
  const status = screen.getByRole('status').textContent ?? '';
  assert.match(status, /₹2,500/);
  assert.match(status, /₹10,000/);
  assert.doesNotMatch(status, /refund/i);
  mock.reset();
});

test('a succeeded challenge announces it as succeeded, with no failure copy', async () => {
  setHashToken('overlay-token-dddddddddddddddddddddddddddddddd');
  const challenge = baseChallenge({ state: 'succeeded', progressPaise: 1_000_000, targetReached: true });
  mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({ challenge }) }));
  await renderFreshWidget();
  await waitFor(() => screen.getByText(/succeeded/i));
  assert.doesNotMatch(screen.getByRole('status').textContent ?? '', /refund/i);
  mock.reset();
});

test('a failed challenge shows the exact locked no-refund copy, verbatim', async () => {
  setHashToken('overlay-token-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
  const challenge = baseChallenge({ state: 'failed', progressPaise: 100_000 });
  mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({ challenge }) }));
  await renderFreshWidget();
  await waitFor(() => screen.getByText('Did not happen'));
  assert.ok(screen.getByText(CHALLENGE_FAILURE_COPY));
  mock.reset();
});

test('a cancelled challenge also shows the exact locked no-refund copy, verbatim', async () => {
  setHashToken('overlay-token-ffffffffffffffffffffffffffffffff');
  const challenge = baseChallenge({ state: 'cancelled', progressPaise: 50_000 });
  mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({ challenge }) }));
  await renderFreshWidget();
  await waitFor(() => screen.getByText('Cancelled'));
  assert.ok(screen.getByText(CHALLENGE_FAILURE_COPY));
  mock.reset();
});
