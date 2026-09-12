import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act, render, screen, waitFor } from '@testing-library/react';

mock.module('next/navigation', {
  namedExports: { useParams: () => ({ overlayId: 'ov1' }) },
});
mock.module(new URL('../../../lib/api-origin.ts', import.meta.url).pathname, {
  namedExports: { getApiOrigin: () => 'https://api.example.test' },
});

function setHashToken(token: string | null) {
  window.location.hash = token ? `#token=${token}` : '';
}

async function renderFreshWidget() {
  const { default: LeaderboardWidgetPage } = await import(`./[overlayId]/page.tsx?t=${Math.random()}`);
  render(<LeaderboardWidgetPage />);
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

test('with an empty board, the widget renders its empty state, not an error', async () => {
  setHashToken('overlay-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({ leaderboard: { schemaVersion: 'v1', window: 'weekly', rows: [] } }) }));
  await renderFreshWidget();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(screen.queryByRole('status'), null);
  mock.reset();
});

test('with a partial board (one row), the widget shows rank and tier, never an amount', async () => {
  setHashToken('overlay-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  const leaderboard = { schemaVersion: 'v1', window: 'weekly', rows: [{ rank: 1, viewerRef: 'viewer_abcd1234', tierLabel: 'gold' }] };
  mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({ leaderboard }) }));
  await renderFreshWidget();
  await waitFor(() => screen.getByText('#1'));
  const text = screen.getByRole('status').textContent ?? '';
  assert.match(text, /gold/);
  assert.doesNotMatch(text, /₹/);
  mock.reset();
});

test('with a full board (multiple rows), the widget renders every row and caps at the top 10', async () => {
  setHashToken('overlay-token-cccccccccccccccccccccccccccccccc');
  const rows = Array.from({ length: 15 }, (_, i) => ({ rank: i + 1, viewerRef: `viewer_${i}`, tierLabel: i < 3 ? 'platinum' : 'bronze' }));
  const leaderboard = { schemaVersion: 'v1', window: 'weekly', rows };
  mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({ leaderboard }) }));
  await renderFreshWidget();
  await waitFor(() => screen.getByText('#1'));
  assert.equal(screen.queryByText('#11'), null);
  mock.reset();
});

test('a network failure mid-poll does not throw — the widget renders its quiet empty state', async () => {
  setHashToken('overlay-token-dddddddddddddddddddddddddddddddd');
  mock.method(globalThis, 'fetch', async () => { throw new TypeError('network error'); });
  await renderFreshWidget();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(screen.queryByRole('status'), null);
  mock.reset();
});

test('a malformed leaderboard payload is treated as no board, not rendered or thrown', async () => {
  setHashToken('overlay-token-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
  mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({ leaderboard: { rows: 'not-an-array' } }) }));
  await renderFreshWidget();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(screen.queryByRole('status'), null);
  mock.reset();
});
