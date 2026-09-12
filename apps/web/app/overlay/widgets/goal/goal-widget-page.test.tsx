import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, waitFor } from '@testing-library/react';

// The widget page reads the overlay id via next/navigation's useParams()
// and the session token from the URL hash fragment (never a query param —
// see page.tsx's file comment on why), exactly like
// apps/web/app/overlay/[overlayId]/page.tsx already does. Both are mocked
// here rather than through a real Next.js router, matching this file's
// narrow, DOM-only test harness (see test-support/README.md).
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
  const { default: GoalWidgetPage } = await import(`./[overlayId]/page.tsx?t=${Math.random()}`);
  render(<GoalWidgetPage />);
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

test('with no live goal (goal: null), the widget renders its empty state, not an error', async () => {
  setHashToken('overlay-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({ goal: null }) }));
  await renderFreshWidget();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(screen.queryByRole('status'), null);
  mock.reset();
});

test('with a partial goal, the widget shows the title, amounts and a partial fill', async () => {
  setHashToken('overlay-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  const goal = { schemaVersion: 'v1', goalId: 'g1', title: 'New PC fund', targetAmountPaise: 1_000_000, window: 'open', progressPaise: 250_000, reached: false };
  mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({ goal }) }));
  await renderFreshWidget();
  await waitFor(() => screen.getByText('New PC fund'));
  assert.match(screen.getByRole('status').textContent ?? '', /₹2,500/);
  assert.match(screen.getByRole('status').textContent ?? '', /₹10,000/);
  assert.doesNotMatch(screen.getByRole('status').textContent ?? '', /reached/i);
  mock.reset();
});

test('with a reached goal, the widget announces it as reached', async () => {
  setHashToken('overlay-token-cccccccccccccccccccccccccccccccc');
  const goal = { schemaVersion: 'v1', goalId: 'g1', title: 'New PC fund', targetAmountPaise: 1_000_000, window: 'open', progressPaise: 1_000_000, reached: true };
  mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({ goal }) }));
  await renderFreshWidget();
  await waitFor(() => screen.getByText(/reached/i));
  mock.reset();
});
