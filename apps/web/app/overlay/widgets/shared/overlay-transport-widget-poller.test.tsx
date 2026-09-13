import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act, render, screen, waitFor } from '@testing-library/react';

/*
 * The four WidgetPoller-based widgets (recent-tips, top-supporters,
 * supporter-ticker, mega-tip-banner) had no page-level test coverage
 * before this migration. They now share WidgetPoller.tsx's transport
 * (../shared/overlay-transport.ts) with every other widget — this file
 * covers their no-data / partial / full / degrade states directly,
 * mirroring the existing per-widget test files (goal, leaderboard, ...).
 *
 * These widgets render a plain `<section>` (no explicit role), unlike the
 * other widgets' `role="status"` card, so assertions here query by text
 * and by the shared `.l16-widget-card` class rather than by role.
 */
mock.module('next/navigation', {
  namedExports: { useParams: () => ({ overlayId: 'ov1' }) },
});
mock.module(new URL('../../../lib/api-origin.ts', import.meta.url).pathname, {
  namedExports: { getApiOrigin: () => 'https://api.example.test' },
});

function setHashToken(token: string | null) {
  window.location.hash = token ? `#token=${token}` : '';
}

function hasCard(): boolean {
  return document.querySelector('.l16-widget-card') !== null;
}

async function renderFresh(path: string) {
  const mod = await import(`${path}?t=${Math.random()}`);
  const Page = mod.default;
  const view = render(<Page />);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  return view;
}

test('recent-tips: no data renders nothing, a network failure never throws', async () => {
  setHashToken('overlay-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1');
  mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({ schemaVersion: 'v1', tips: [] }) }));
  const { unmount } = await renderFresh('../recent-tips/[overlayId]/page.tsx');
  assert.equal(hasCard(), false);
  unmount();
  mock.reset();
});

test('recent-tips: partial (one tip, no message) and full (with message) both render', async () => {
  setHashToken('overlay-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2');
  const tips = [
    { displayName: 'Asha', amountPaise: 5_000, message: null, createdAt: '2026-09-01T00:00:00.000Z' },
    { displayName: 'Bilal', amountPaise: 25_000, message: 'gg', createdAt: '2026-09-01T00:01:00.000Z' },
  ];
  mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({ schemaVersion: 'v1', tips }) }));
  const { unmount } = await renderFresh('../recent-tips/[overlayId]/page.tsx');
  await waitFor(() => screen.getByText(/Asha/));
  assert.match(document.querySelector('.l16-widget-card')?.textContent ?? '', /Bilal.*gg/);
  unmount();
  mock.reset();
});

test('recent-tips: a network failure degrades to empty, never throws', async () => {
  setHashToken('overlay-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3');
  mock.method(globalThis, 'fetch', async () => { throw new TypeError('network error'); });
  const { unmount } = await renderFresh('../recent-tips/[overlayId]/page.tsx');
  assert.equal(hasCard(), false);
  unmount();
  mock.reset();
});

test('top-supporters: no data renders nothing', async () => {
  setHashToken('overlay-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb1');
  mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({ schemaVersion: 'v1', supporters: [] }) }));
  const { unmount } = await renderFresh('../top-supporters/[overlayId]/page.tsx');
  assert.equal(hasCard(), false);
  unmount();
  mock.reset();
});

test('top-supporters: a full list renders every row', async () => {
  setHashToken('overlay-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2');
  const supporters = [{ rank: 1, viewerRef: 'viewer_a', tierLabel: 'gold' }, { rank: 2, viewerRef: 'viewer_b', tierLabel: 'silver' }];
  mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({ schemaVersion: 'v1', supporters }) }));
  const { unmount } = await renderFresh('../top-supporters/[overlayId]/page.tsx');
  await waitFor(() => screen.getByText(/#1/));
  assert.match(document.querySelector('.l16-widget-card')?.textContent ?? '', /silver/);
  unmount();
  mock.reset();
});

test('supporter-ticker: no entries renders nothing, entries render as a ticker', async () => {
  setHashToken('overlay-token-ccccccccccccccccccccccccccccccc1');
  mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({ schemaVersion: 'v1', entries: [] }) }));
  const first = await renderFresh('../supporter-ticker/[overlayId]/page.tsx');
  assert.equal(hasCard(), false);
  first.unmount();
  mock.reset();

  setHashToken('overlay-token-ccccccccccccccccccccccccccccccc2');
  const entries = [{ viewerRef: 'viewer_c', tierLabel: 'bronze', supportedAt: '2026-09-01T00:00:00.000Z' }];
  mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({ schemaVersion: 'v1', entries }) }));
  const second = await renderFresh('../supporter-ticker/[overlayId]/page.tsx');
  await waitFor(() => screen.getByText(/bronze/));
  second.unmount();
  mock.reset();
});

test('mega-tip-banner: no banner renders nothing', async () => {
  setHashToken('overlay-token-ddddddddddddddddddddddddddddddd1');
  mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({ schemaVersion: 'v1', banner: null }) }));
  const { unmount } = await renderFresh('../mega-tip-banner/[overlayId]/page.tsx');
  assert.equal(hasCard(), false);
  unmount();
  mock.reset();
});

test('mega-tip-banner: a banner renders the amount', async () => {
  setHashToken('overlay-token-ddddddddddddddddddddddddddddddd2');
  const banner = { displayName: 'Chandan', amountPaise: 5_00_000, createdAt: '2026-09-01T00:00:00.000Z' };
  mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({ schemaVersion: 'v1', banner }) }));
  const { unmount } = await renderFresh('../mega-tip-banner/[overlayId]/page.tsx');
  await waitFor(() => screen.getByText(/Chandan/));
  assert.match(document.querySelector('.l16-widget-card')?.textContent ?? '', /₹5,000/);
  unmount();
  mock.reset();
});

test('mega-tip-banner: a 401 degrades quietly, never throws', async () => {
  setHashToken('overlay-token-ddddddddddddddddddddddddddddddd3');
  mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 401, json: async () => ({}) }));
  const { unmount } = await renderFresh('../mega-tip-banner/[overlayId]/page.tsx');
  assert.equal(hasCard(), false);
  unmount();
  mock.reset();
});
