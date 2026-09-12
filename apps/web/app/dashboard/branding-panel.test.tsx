import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { mockApi } from '../test-support/mock-api';
import { controllable } from '../test-support/controllable';
import type * as api from '../lib/api';

// BrandingPanel takes channelId as a prop and calls ../lib/api directly —
// no AppShell/useChannelBootstrap involved, so no auth/billing fixtures
// are needed, only the three Lottie endpoints it actually calls. Uploads
// are mocked at uploadLottieAsset itself (the same seam every other
// api.ts-backed test mocks) — no real network call is ever made.

const getLottieAssets = controllable<Parameters<typeof api.getLottieAssets>, Awaited<ReturnType<typeof api.getLottieAssets>>>(
  async () => ({ schemaVersion: 'v1', items: [] }),
);
const uploadLottieAsset = controllable<Parameters<typeof api.uploadLottieAsset>, Awaited<ReturnType<typeof api.uploadLottieAsset>>>(
  async () => { throw new Error('uploadLottieAsset not stubbed for this test'); },
);

mockApi({
  getLottieAssets: getLottieAssets.fn,
  uploadLottieAsset: uploadLottieAsset.fn,
  deleteLottieAsset: async () => undefined,
});

async function renderFreshPanel() {
  const { BrandingPanel } = await import(`./BrandingPanel?t=${Math.random()}`);
  render(<BrandingPanel channelId="c1" />);
  // Let the initial getLottieAssets() effect settle before the test acts.
  await waitFor(() => screen.getAllByText('No custom animation').length > 0);
}

function fileInputFor(slotLabel: string): HTMLInputElement {
  const label = screen.getByText(slotLabel).closest('.channel-row')!;
  return label.querySelector('input[type="file"]') as HTMLInputElement;
}

test('uploading a non-JSON file is rejected client-side with an actionable message, before any network call', async () => {
  await renderFreshPanel();
  let uploadCalled = false;
  uploadLottieAsset.set(async () => { uploadCalled = true; return { displayStyle: 'small_pill', artifactId: 'a1' }; });

  const input = fileInputFor('Small pill');
  const badFile = new File(['not json at all {{{'], 'bad.json', { type: 'application/json' });
  fireEvent.change(input, { target: { files: [badFile] } });

  await waitFor(() => screen.getByRole('alert'));
  assert.equal(screen.getByRole('alert').textContent, 'That file is not valid JSON.');
  assert.equal(uploadCalled, false);
});

test('a server-side upload failure (e.g. oversize file rejected by the 2 MB limit) surfaces the server message, not a generic one', async () => {
  await renderFreshPanel();
  uploadLottieAsset.set(async () => { throw new Error('Animation file exceeds the 2 MB limit.'); });

  const input = fileInputFor('Banner');
  const bigFile = new File([JSON.stringify({ v: 5, layers: [] })], 'anim.json', { type: 'application/json' });
  fireEvent.change(input, { target: { files: [bigFile] } });

  await waitFor(() => screen.getByRole('alert'));
  assert.equal(screen.getByRole('alert').textContent, 'Animation file exceeds the 2 MB limit.');
});

test('a successful upload shows the success message and refreshes the slot from the server (byte size now shown, label switches to Replace)', async () => {
  await renderFreshPanel();
  uploadLottieAsset.set(async () => ({ displayStyle: 'celebration', artifactId: 'a2' }));
  getLottieAssets.set(async () => ({
    schemaVersion: 'v1',
    items: [{ displayStyle: 'celebration', artifactId: 'a2', byteSize: 4096, updatedAt: '2026-02-01T00:00:00.000Z' }],
  }));

  const input = fileInputFor('Celebration');
  const goodFile = new File([JSON.stringify({ v: 5, layers: [] })], 'anim.json', { type: 'application/json' });
  fireEvent.change(input, { target: { files: [goodFile] } });

  await waitFor(() => screen.getByText('Celebration animation uploaded.'));
  await waitFor(() => screen.getByText(/^4\.0 KB · updated /));
  assert.ok(screen.getByText('Replace'));
});
