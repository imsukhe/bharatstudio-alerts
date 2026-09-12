import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { mockApi } from '../test-support/mock-api';
import { controllable } from '../test-support/controllable';
import type * as api from '../lib/api';

// Split out from branding-panel.test.tsx (which only covers upload) because
// mockApi(...) may only run once per file — deleteLottieAsset there is a
// static `async () => undefined` with no failure path. This file gives it
// its own controllable so both the success and failure paths of
// handleDelete can be exercised.

const getLottieAssets = controllable<Parameters<typeof api.getLottieAssets>, Awaited<ReturnType<typeof api.getLottieAssets>>>(
  async () => ({
    schemaVersion: 'v1',
    items: [{ displayStyle: 'celebration', artifactId: 'a1', byteSize: 2048, updatedAt: '2026-01-01T00:00:00.000Z' }],
  }),
);
const deleteLottieAsset = controllable<Parameters<typeof api.deleteLottieAsset>, Awaited<ReturnType<typeof api.deleteLottieAsset>>>(
  async () => undefined,
);

mockApi({
  getLottieAssets: getLottieAssets.fn,
  uploadLottieAsset: async () => { throw new Error('uploadLottieAsset not stubbed for this test'); },
  deleteLottieAsset: deleteLottieAsset.fn,
});

async function renderFreshPanel() {
  const { BrandingPanel } = await import(`./BrandingPanel?t=${Math.random()}`);
  render(<BrandingPanel channelId="c1" />);
  // Wait for the initial getLottieAssets() effect to populate the
  // Celebration slot (it starts with an uploaded asset, so "Remove" exists).
  await waitFor(() => screen.getByRole('button', { name: 'Remove' }));
}

test('deleting a slot calls deleteLottieAsset with the right channel/slot, shows a success notice, and refreshes the slot back to empty', async () => {
  await renderFreshPanel();
  let calledWith: unknown[] = [];
  deleteLottieAsset.set(async (...args) => { calledWith = args; });
  getLottieAssets.set(async () => ({ schemaVersion: 'v1', items: [] }));

  fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

  await waitFor(() => screen.getByText('Celebration animation removed.'));
  assert.deepEqual(calledWith, ['c1', 'celebration']);
  // Slot reverts to "No custom animation" / "Upload" once the refresh
  // completes — this would still say "Replace"/keep the Remove button if
  // handleDelete's refresh() call regressed. All six slots now say "No
  // custom animation" (the other five always did), so assert on the
  // Celebration row specifically.
  await waitFor(() => {
    const row = screen.getByText('Celebration').closest('.channel-row')!;
    assert.ok(row.textContent?.includes('No custom animation'));
  });
  assert.equal(screen.queryByRole('button', { name: 'Remove' }), null);
});

test('a failed delete surfaces the server error message and leaves the asset in place (no false success notice)', async () => {
  getLottieAssets.set(async () => ({
    schemaVersion: 'v1',
    items: [{ displayStyle: 'celebration', artifactId: 'a1', byteSize: 2048, updatedAt: '2026-01-01T00:00:00.000Z' }],
  }));
  await renderFreshPanel();
  deleteLottieAsset.set(async () => { throw new Error('Animation is still referenced by an active alert bracket.'); });

  fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

  await waitFor(() => screen.getByRole('alert'));
  assert.equal(screen.getByRole('alert').textContent, 'Animation is still referenced by an active alert bracket.');
  // No success notice must appear alongside the error.
  assert.equal(screen.queryByText(/animation removed\.$/), null);
  // The asset is still shown as present (refresh() was never called on the
  // failure path, and the original getLottieAssets fixture is unchanged).
  assert.ok(screen.getByRole('button', { name: 'Remove' }));
});
