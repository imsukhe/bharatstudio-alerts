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
mock.module(stickerApiPath, {
  namedExports: {
    listStickers: async () => ({ schemaVersion: 'v1', items: [] as stickerApi.Sticker[] }),
    setStickerEnabled: async () => { throw new Error('not stubbed for this test'); },
  },
});

const creatorPackApiPath = new URL('./creator-pack-api.ts', import.meta.url).pathname;
const listCreatorPack = controllable<Parameters<typeof creatorPackApi.listCreatorPack>, Awaited<ReturnType<typeof creatorPackApi.listCreatorPack>>>(
  async () => ({ schemaVersion: 'v1', items: [] }),
);
const uploadCreatorPackSticker = controllable<Parameters<typeof creatorPackApi.uploadCreatorPackSticker>, Awaited<ReturnType<typeof creatorPackApi.uploadCreatorPackSticker>>>(
  async () => { throw new Error('uploadCreatorPackSticker not stubbed for this test'); },
);
const setCreatorPackStickerEnabled = controllable<Parameters<typeof creatorPackApi.setCreatorPackStickerEnabled>, Awaited<ReturnType<typeof creatorPackApi.setCreatorPackStickerEnabled>>>(
  async () => { throw new Error('setCreatorPackStickerEnabled not stubbed for this test'); },
);
mock.module(creatorPackApiPath, {
  namedExports: { listCreatorPack: listCreatorPack.fn, uploadCreatorPackSticker: uploadCreatorPackSticker.fn, setCreatorPackStickerEnabled: setCreatorPackStickerEnabled.fn },
});

async function renderFreshPage() {
  const { default: StickersPage } = await import(`./page?t=${Math.random()}`);
  render(<StickersPage />);
  await waitFor(() => screen.getByText('@testhandle'));
}

test('an owner sees their pack stickers, pending-review state, and the upload form — never a file picker', async () => {
  getChannel.set(async () => baseChannelDetails('owner'));
  listCreatorPack.set(async () => ({
    schemaVersion: 'v1',
    items: [
      { schemaVersion: 'v1', id: 'p1', displayName: 'My Wave', category: 'Reaction', byteSize: 10, enabled: true, status: 'active', creatorAttested: true, updatedAt: '2026-09-01T00:00:00.000Z' },
      { schemaVersion: 'v1', id: 'p2', displayName: 'Studio Exclusive', category: 'Hype', byteSize: 20, enabled: true, status: 'pending_review', creatorAttested: true, updatedAt: '2026-09-01T00:00:00.000Z' },
    ],
  }));
  await renderFreshPage();
  await waitFor(() => screen.getByText('My Wave'));
  assert.ok(screen.getByText('Awaiting platform review before it appears to viewers.'));
  assert.ok(screen.getByRole('button', { name: 'Upload' }));
  // Creator-pack upload is a JSON-render-document form, never a raw binary
  // file picker — this is the one legitimate creator-supplied path, not a
  // viewer-upload surface, and it never accepts a file blob directly.
  assert.equal(document.querySelector('input[type="file"]'), null);
});

test('a non-manager sees no upload form and no toggle', async () => {
  getChannel.set(async () => baseChannelDetails('viewer'));
  listCreatorPack.set(async () => ({
    schemaVersion: 'v1',
    items: [{ schemaVersion: 'v1', id: 'p1', displayName: 'My Wave', category: 'Reaction', byteSize: 10, enabled: true, status: 'active', creatorAttested: true, updatedAt: '2026-09-01T00:00:00.000Z' }],
  }));
  await renderFreshPage();
  await waitFor(() => screen.getByText('Only the channel owner or an admin can manage the creator pack.'));
  assert.equal(screen.queryByRole('button', { name: 'Upload' }), null);
  assert.equal(screen.queryByRole('button', { name: 'Turn off' }), null);
});

test('uploading a pack sticker refreshes the list', async () => {
  getChannel.set(async () => baseChannelDetails('owner'));
  listCreatorPack.set(async () => ({ schemaVersion: 'v1', items: [] }));
  uploadCreatorPackSticker.set(async () => ({ schemaVersion: 'v1', id: 'p3', status: 'active' }));
  await renderFreshPage();
  await waitFor(() => screen.getByText("You haven't added any pack stickers yet."));

  fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Confetti' } });
  fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'Celebration' } });
  fireEvent.change(screen.getByLabelText('Render document (JSON)'), { target: { value: '{"v":"1.0","layers":[]}' } });
  fireEvent.click(screen.getByLabelText('I confirm I hold the rights to this asset'));

  listCreatorPack.set(async () => ({
    schemaVersion: 'v1',
    items: [{ schemaVersion: 'v1', id: 'p3', displayName: 'Confetti', category: 'Celebration', byteSize: 20, enabled: true, status: 'active', creatorAttested: true, updatedAt: '2026-09-01T00:00:00.000Z' }],
  }));
  fireEvent.click(screen.getByRole('button', { name: 'Upload' }));

  await waitFor(() => screen.getByText('Confetti'));
});

test('toggling a pack sticker off updates its status', async () => {
  getChannel.set(async () => baseChannelDetails('owner'));
  listCreatorPack.set(async () => ({
    schemaVersion: 'v1',
    items: [{ schemaVersion: 'v1', id: 'p1', displayName: 'My Wave', category: 'Reaction', byteSize: 10, enabled: true, status: 'active', creatorAttested: true, updatedAt: '2026-09-01T00:00:00.000Z' }],
  }));
  setCreatorPackStickerEnabled.set(async () => ({ schemaVersion: 'v1', id: 'p1', enabled: false }));
  await renderFreshPage();
  await waitFor(() => screen.getByText('My Wave'));
  fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
  await waitFor(() => screen.getByRole('button', { name: 'Turn on' }));
});
