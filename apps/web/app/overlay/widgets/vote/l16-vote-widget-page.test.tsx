import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act, render, screen, waitFor } from '@testing-library/react';

// Mirrors ../goal/goal-widget-page.test.tsx exactly — see that file's
// comment for why useParams()/api-origin are mocked here rather than
// through a real Next.js router.
mock.module('next/navigation', {
  namedExports: { useParams: () => ({ overlayId: 'ov1', definitionId: 'def1' }) },
});
mock.module(new URL('../../../lib/api-origin.ts', import.meta.url).pathname, {
  namedExports: { getApiOrigin: () => 'https://api.example.test' },
});

function setHashToken(token: string | null) {
  window.location.hash = token ? `#token=${token}` : '';
}

async function renderFreshWidget() {
  const { default: VoteWidgetPage } = await import(`./[overlayId]/[definitionId]/page.tsx?t=${Math.random()}`);
  render(<VoteWidgetPage />);
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

test('with no tally data (tally: null), the widget renders its empty state, not an error', async () => {
  setHashToken('overlay-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({ tally: null }) }));
  await renderFreshWidget();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(screen.queryByRole('status'), null);
  mock.reset();
});

test('with a partial (open, unresolved) tally, the widget shows option counts and no "Resolved" text', async () => {
  setHashToken('overlay-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  const tally = { schemaVersion: 'v1', options: [{ optionKey: 'game-a', label: 'Game A', voteCount: 3 }, { optionKey: 'game-b', label: 'Game B', voteCount: 1 }], resolved: false, resolvedOptionKey: null };
  mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({ tally }) }));
  await renderFreshWidget();
  await waitFor(() => screen.getByText(/Game A/));
  assert.match(screen.getByRole('status').textContent ?? '', /3 votes/);
  assert.doesNotMatch(screen.getByRole('status').textContent ?? '', /resolved/i);
  mock.reset();
});

test('with a full, resolved tally, the widget announces the winning option', async () => {
  setHashToken('overlay-token-cccccccccccccccccccccccccccccccc');
  const tally = { schemaVersion: 'v1', options: [{ optionKey: 'game-a', label: 'Game A', voteCount: 2 }, { optionKey: 'game-b', label: 'Game B', voteCount: 1 }], resolved: true, resolvedOptionKey: 'game-a' };
  mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({ tally }) }));
  await renderFreshWidget();
  await waitFor(() => screen.getByText(/Resolved/));
  assert.match(screen.getByRole('status').textContent ?? '', /Game A/);
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

test('a malformed tally payload is treated as no tally, not rendered or thrown', async () => {
  setHashToken('overlay-token-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
  mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({ tally: { options: 'not-an-array' } }) }));
  await renderFreshWidget();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(screen.queryByRole('status'), null);
  mock.reset();
});

test('a 401 as the very first poll response never renders a tally', async () => {
  setHashToken('overlay-token-gggggggggggggggggggggggggggggggg');
  mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 401, json: async () => ({}) }));
  await renderFreshWidget();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(screen.queryByRole('status'), null);
  mock.reset();
});
