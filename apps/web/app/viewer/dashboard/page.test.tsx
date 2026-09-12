import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, render, screen, waitFor } from '@testing-library/react';
import { mockViewerApi } from '../../test-support/mock-viewer-api';
import { controllable } from '../../test-support/controllable';
import type * as viewerApi from '../lib/viewer-api';

const dashboardRows = controllable<Parameters<typeof viewerApi.getViewerDashboard>, Awaited<ReturnType<typeof viewerApi.getViewerDashboard>>>(
  async () => [],
);

mockViewerApi({ getViewerDashboard: dashboardRows.fn });

async function renderFreshViewerDashboard() {
  const { default: ViewerDashboardPage } = await import(`./page?t=${Math.random()}`);
  await act(async () => {
    render(<ViewerDashboardPage />);
    // The hook's fetcher may resolve in the first microtask. Keep that
    // initial resolution within the same React test boundary as render.
    await Promise.resolve();
  });
}

test('shows Loading… before the fetch resolves', async () => {
  let resolveRows: (rows: []) => void = () => {};
  dashboardRows.set(() => new Promise((resolve) => { resolveRows = resolve; }));
  await renderFreshViewerDashboard();
  assert.equal(screen.getByRole('status').textContent, 'Loading…');
  await act(async () => { resolveRows([]); });
  await waitFor(() => screen.getByText(/haven.t supported any channel yet/));
});

test('shows the error state when the fetch fails, using the hook\'s own fallback message', async () => {
  dashboardRows.set(async () => { throw new Error('boom'); });
  await renderFreshViewerDashboard();
  await waitFor(() => screen.getByRole('alert'));
  assert.equal(screen.getByRole('alert').textContent, 'boom');
});

test('shows the empty state when there is no support history', async () => {
  dashboardRows.set(async () => []);
  await renderFreshViewerDashboard();
  await waitFor(() => screen.getByText(/haven.t supported any channel yet/));
});

test('renders each supported channel row when there is history', async () => {
  dashboardRows.set(async () => [{
    channelId: 'ch1', channelHandle: 'somecreator', channelDisplayName: 'Some Creator',
    firstSupportedAt: '2026-01-01T00:00:00.000Z', lastSupportedAt: '2026-02-01T00:00:00.000Z',
    lifetimeAmountPaise: '50000', tipCount: '3', challengeCount: '0', memberState: 'none' as const,
  }]);
  await renderFreshViewerDashboard();
  await waitFor(() => screen.getByText('Some Creator'));
  assert.ok(screen.getByText(/₹500/));
});

test('this page renders the viewer\'s own nav, never the creator AppShell/TopNav chrome', async () => {
  dashboardRows.set(async () => []);
  await renderFreshViewerDashboard();
  await waitFor(() => screen.getByText(/haven.t supported any channel yet/));
  assert.ok(screen.getByRole('navigation', { name: 'Viewer navigation' }));
  assert.equal(screen.queryByRole('navigation', { name: 'Primary navigation' }), null);
  assert.equal(screen.queryByText('Companion'), null);
});
