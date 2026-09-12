import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act, render, screen, waitFor } from '@testing-library/react';

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
  const { default: HypeWidgetPage } = await import(`./[overlayId]/[definitionId]/page.tsx?t=${Math.random()}`);
  render(<HypeWidgetPage />);
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

test('with no active activation (hype: null), the widget renders its empty state, not an error', async () => {
  setHashToken('overlay-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({ hype: null }) }));
  await renderFreshWidget();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(screen.queryByRole('status'), null);
  mock.reset();
});

test('with a partial (below-threshold) meter, the widget shows amounts and no "MAXED OUT" text', async () => {
  setHashToken('overlay-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  const hype = { schemaVersion: 'v1', meterPaise: 250_000, thresholdPaise: 500_000, reached: false, startedAt: '2026-09-07T00:00:00.000Z', endsAt: '2026-09-07T00:05:00.000Z', ended: false };
  mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({ hype }) }));
  await renderFreshWidget();
  await waitFor(() => screen.getByText(/Hype meter/));
  assert.match(screen.getByRole('status').textContent ?? '', /₹2,500/);
  assert.doesNotMatch(screen.getByRole('status').textContent ?? '', /MAXED OUT/);
  mock.reset();
});

test('with a reached meter (full data), the widget announces it as maxed out', async () => {
  setHashToken('overlay-token-cccccccccccccccccccccccccccccccc');
  const hype = { schemaVersion: 'v1', meterPaise: 600_000, thresholdPaise: 500_000, reached: true, startedAt: '2026-09-07T00:00:00.000Z', endsAt: '2026-09-07T00:05:00.000Z', ended: false };
  mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({ hype }) }));
  await renderFreshWidget();
  await waitFor(() => screen.getByText(/MAXED OUT/));
  mock.reset();
});

test('an ended activation renders nothing, even with a meter value present', async () => {
  setHashToken('overlay-token-ffffffffffffffffffffffffffffffff');
  const hype = { schemaVersion: 'v1', meterPaise: 600_000, thresholdPaise: 500_000, reached: true, startedAt: '2026-09-07T00:00:00.000Z', endsAt: '2026-09-07T00:05:00.000Z', ended: true };
  mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({ hype }) }));
  await renderFreshWidget();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(screen.queryByRole('status'), null);
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

test('a malformed hype payload is treated as no state, not rendered or thrown', async () => {
  setHashToken('overlay-token-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
  mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({ hype: { meterPaise: 'not-a-number' } }) }));
  await renderFreshWidget();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(screen.queryByRole('status'), null);
  mock.reset();
});
