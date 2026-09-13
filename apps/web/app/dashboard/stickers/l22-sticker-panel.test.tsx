import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { mockApi } from '../../test-support/mock-api';
import { controllable } from '../../test-support/controllable';
import { baseBillingView, baseChannelDetails } from '../../test-support/fixtures';
import type * as api from '../../lib/api';
import type * as stickerApi from './sticker-api';
import type * as creatorPackApi from './creator-pack-api';

const baseUser: api.CurrentUser = {
  schemaVersion: 'v1', userId: 'u1', displayName: 'Test Creator',
  channels: [{ channelId: 'c1', role: 'owner', payoutOnboardingDone: true }],
};

const getChannel = controllable<Parameters<typeof api.getChannel>, Awaited<ReturnType<typeof api.getChannel>>>(
  async () => baseChannelDetails('owner'),
);

mockApi({
  getAccessToken: () => 'fake-token',
  getTermsStatus: async () => ({ schemaVersion: 'v1', documents: [], accepted: true }),
  getCurrentUser: async () => baseUser,
  getChannel: getChannel.fn,
  getBilling: async () => baseBillingView,
});

const stickerApiPath = new URL('./sticker-api.ts', import.meta.url).pathname;
const listStickers = controllable<Parameters<typeof stickerApi.listStickers>, Awaited<ReturnType<typeof stickerApi.listStickers>>>(
  async () => ({ schemaVersion: 'v1', items: [] }),
);
const setStickerEnabled = controllable<Parameters<typeof stickerApi.setStickerEnabled>, Awaited<ReturnType<typeof stickerApi.setStickerEnabled>>>(
  async () => { throw new Error('setStickerEnabled not stubbed for this test'); },
);
mock.module(stickerApiPath, {
  namedExports: { listStickers: listStickers.fn, setStickerEnabled: setStickerEnabled.fn },
});

// L22 gap-fill: the page also mounts CreatorPackPanel, which calls
// creator-pack-api.ts — mocked here too so this file's real fetches never
// leave jsdom, same rationale as sticker-api.ts above. This file's own
// coverage is l22b-creator-pack-panel.test.tsx.
const creatorPackApiPath = new URL('./creator-pack-api.ts', import.meta.url).pathname;
const listCreatorPack = controllable<Parameters<typeof creatorPackApi.listCreatorPack>, Awaited<ReturnType<typeof creatorPackApi.listCreatorPack>>>(
  async () => ({ schemaVersion: 'v1', items: [] }),
);
mock.module(creatorPackApiPath, {
  namedExports: {
    listCreatorPack: listCreatorPack.fn,
    uploadCreatorPackSticker: async () => { throw new Error('uploadCreatorPackSticker not stubbed for this test'); },
    setCreatorPackStickerEnabled: async () => { throw new Error('setCreatorPackStickerEnabled not stubbed for this test'); },
  },
});

async function renderFreshPage() {
  const { default: StickersPage } = await import(`./page?t=${Math.random()}`);
  render(<StickersPage />);
  await waitFor(() => screen.getByText('@testhandle'));
}

test('an owner sees the on/off control and no upload field anywhere', async () => {
  getChannel.set(async () => baseChannelDetails('owner'));
  listStickers.set(async () => ({
    schemaVersion: 'v1',
    items: [{ schemaVersion: 'v1', id: 's1', externalKey: 'STK-001', displayName: 'Confetti', category: 'Celebration', minTier: 'free', byteSize: 42, enabled: true, updatedAt: '2026-09-01T00:00:00.000Z' }],
  }));
  await renderFreshPage();
  await waitFor(() => screen.getByText('Confetti'));
  assert.ok(screen.getByRole('button', { name: 'Turn off' }));
  // No file input exists anywhere on this page — the platform catalogue
  // section only ever toggles an id that already exists in the catalogue
  // (never supplies an asset). Creator-pack uploads (a separate, explicit
  // JSON-textarea form, not a binary file picker) are covered by
  // l22b-creator-pack-panel.test.tsx.
  assert.equal(document.querySelector('input[type="file"]'), null);
});

test('a viewer (non-manager) sees no toggle, only the read-only explanation', async () => {
  getChannel.set(async () => baseChannelDetails('viewer'));
  listStickers.set(async () => ({
    schemaVersion: 'v1',
    items: [{ schemaVersion: 'v1', id: 's1', externalKey: 'STK-001', displayName: 'Confetti', category: 'Celebration', minTier: 'free', byteSize: 42, enabled: true, updatedAt: '2026-09-01T00:00:00.000Z' }],
  }));
  await renderFreshPage();
  await waitFor(() => screen.getByText('Only the channel owner or an admin can turn stickers on or off.'));
  assert.equal(screen.queryByRole('button', { name: 'Turn off' }), null);
});

test('toggling a sticker off updates its status', async () => {
  getChannel.set(async () => baseChannelDetails('owner'));
  listStickers.set(async () => ({
    schemaVersion: 'v1',
    items: [{ schemaVersion: 'v1', id: 's1', externalKey: 'STK-001', displayName: 'Confetti', category: 'Celebration', minTier: 'free', byteSize: 42, enabled: true, updatedAt: '2026-09-01T00:00:00.000Z' }],
  }));
  setStickerEnabled.set(async () => ({ schemaVersion: 'v1', stickerId: 's1', enabled: false }));
  await renderFreshPage();
  await waitFor(() => screen.getByText('Confetti'));
  fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
  await waitFor(() => screen.getByRole('button', { name: 'Turn on' }));
  assert.ok(screen.getByText('Off'));
});

test('an empty catalogue shows the empty-state message', async () => {
  getChannel.set(async () => baseChannelDetails('owner'));
  listStickers.set(async () => ({ schemaVersion: 'v1', items: [] }));
  await renderFreshPage();
  await waitFor(() => screen.getByText('No stickers are available at your current tier yet.'));
});
