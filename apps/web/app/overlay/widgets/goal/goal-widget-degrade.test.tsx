import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act, render, screen } from '@testing-library/react';

/*
 * This is a browser-source widget polled by OBS on a live stream — a
 * thrown error here is dead air, not a stack trace anyone sees. page.test.tsx
 * in this directory already covers no-token / no-goal / partial / reached.
 * This file adds the two remaining ways real data can misbehave: a network
 * failure mid-poll, and a malformed/garbage `goal` payload from the server —
 * both must degrade to the same silent empty state, never throw.
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
  const { default: GoalWidgetPage } = await import(`./[overlayId]/page.tsx?t=${Math.random()}`);
  render(<GoalWidgetPage />);
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

test('a malformed goal payload (fails isOverlayGoal) is treated as no goal, not rendered or thrown', async () => {
  setHashToken('overlay-token-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
  mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({ goal: { title: 'missing required fields' } }) }));
  await renderFreshWidget();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(screen.queryByRole('status'), null);
  assert.equal(screen.queryByText('missing required fields'), null);
  mock.reset();
});

test('a 401 as the very first poll response never renders a goal', async () => {
  setHashToken('overlay-token-gggggggggggggggggggggggggggggggg');
  mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 401, json: async () => ({}) }));
  await renderFreshWidget();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(screen.queryByRole('status'), null);
  mock.reset();
});
