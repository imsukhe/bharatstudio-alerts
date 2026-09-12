import assert from 'node:assert/strict';
import test from 'node:test';
import { getViewerDashboard, getViewerSessions, requestViewerAccountDeletion, setViewerProfileVisibility } from './viewer-api';

const UUID = '00000000-0000-4000-8000-0000000000a1';

async function withViewerResponse(payload: unknown, run: () => Promise<void>): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalOrigin = process.env.NEXT_PUBLIC_API_ORIGIN;
  process.env.NEXT_PUBLIC_API_ORIGIN = 'http://localhost:4100';
  window.sessionStorage.setItem('bharatstudio.alerts.viewer.session', 'synthetic-viewer-token-with-at-least-32-characters');
  globalThis.fetch = async () => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalOrigin === undefined) delete process.env.NEXT_PUBLIC_API_ORIGIN;
    else process.env.NEXT_PUBLIC_API_ORIGIN = originalOrigin;
    window.sessionStorage.removeItem('bharatstudio.alerts.viewer.session');
  }
}

test('viewer client accepts only complete, narrow dashboard/session/deletion responses', async () => {
  await withViewerResponse({
    schemaVersion: 'v1', supportedChannels: [{
      channelId: UUID, channelHandle: 'synthetic', channelDisplayName: 'Synthetic',
      firstSupportedAt: '2026-09-01T00:00:00.000Z', lastSupportedAt: '2026-09-02T00:00:00.000Z',
      lifetimeAmountPaise: '5000', tipCount: '2', challengeCount: '0', memberState: 'active',
    }],
  }, async () => {
    assert.equal((await getViewerDashboard())[0]?.channelId, UUID);
  });
  await withViewerResponse({
    schemaVersion: 'v1', sessions: [{
      sessionId: UUID, createdAt: '2026-09-01T00:00:00.000Z', lastSeenAt: '2026-09-02T00:00:00.000Z',
      expiresAt: '2026-10-01T00:00:00.000Z', deviceLabel: null, current: true,
    }],
  }, async () => {
    assert.equal((await getViewerSessions())[0]?.current, true);
  });
  await withViewerResponse({ schemaVersion: 'v1', erased: ['email'], retained: ['payments'], legalDispositionOpen: true }, async () => {
    assert.deepEqual(await requestViewerAccountDeletion(), { erased: ['email'], retained: ['payments'], legalDispositionOpen: true });
  });
  await withViewerResponse({ schemaVersion: 'v1', visibility: 'public', slug: 'synthetic-viewer' }, async () => {
    assert.deepEqual(await setViewerProfileVisibility('public', 'synthetic-viewer'), { visibility: 'public', slug: 'synthetic-viewer' });
  });
});

test('viewer client rejects malformed or privacy-expanding nested response data', async () => {
  await withViewerResponse({
    schemaVersion: 'v1', supportedChannels: [{
      channelId: UUID, channelHandle: 'synthetic', channelDisplayName: 'Synthetic',
      firstSupportedAt: 'not-a-date', lastSupportedAt: '2026-09-02T00:00:00.000Z',
      lifetimeAmountPaise: '5000', tipCount: '2', challengeCount: '0', memberState: 'active', viewerAccountId: UUID,
    }],
  }, async () => {
    await assert.rejects(getViewerDashboard(), /Server response was invalid/);
  });
  await withViewerResponse({
    schemaVersion: 'v1', sessions: [{
      sessionId: UUID, createdAt: '2026-09-01T00:00:00.000Z', lastSeenAt: '2026-09-02T00:00:00.000Z',
      expiresAt: '2026-10-01T00:00:00.000Z', deviceLabel: null, current: 'yes', accessToken: 'leak',
    }],
  }, async () => {
    await assert.rejects(getViewerSessions(), /Server response was invalid/);
  });
  await withViewerResponse({ schemaVersion: 'v1', erased: ['email'], retained: ['payments'], legalDispositionOpen: false }, async () => {
    await assert.rejects(requestViewerAccountDeletion(), /Server response was invalid/);
  });
  await withViewerResponse({ schemaVersion: 'v1', visibility: 'public', slug: 'synthetic-viewer', viewerAccountId: UUID }, async () => {
    await assert.rejects(setViewerProfileVisibility('public', 'synthetic-viewer'), /Server response was invalid/);
  });
  await withViewerResponse({ schemaVersion: 'v1', visibility: 'private', slug: 'privacy-contradiction' }, async () => {
    await assert.rejects(setViewerProfileVisibility('private', null), /Server response was invalid/);
  });
});
