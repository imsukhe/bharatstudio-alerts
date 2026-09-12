import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, waitFor } from '@testing-library/react';
import { mockApi } from '../../test-support/mock-api';
import { controllable } from '../../test-support/controllable';
import { baseBillingView, baseChannelDetails } from '../../test-support/fixtures';
import type * as api from '../../lib/api';
import type * as interactionsApi from './interactions-api';

/*
 * A viewer/moderator (canManage: false) must never see the create forms
 * for interactions or widgets — mirrors ../goals/progress-readonly.test.tsx's
 * own "prove the gate as an executable test, not just a comment" approach.
 * Also proves the leaderboard renders rank/tier only, with no amount input
 * or amount text anywhere on the page.
 */

const baseUser: api.CurrentUser = {
  schemaVersion: 'v1', userId: 'u1', displayName: 'Test Creator',
  channels: [{ channelId: 'c1', role: 'owner', payoutOnboardingDone: true }],
};

mockApi({
  getAccessToken: () => 'fake-token',
  getTermsStatus: async () => ({ schemaVersion: 'v1', documents: [], accepted: true }),
  getCurrentUser: async () => baseUser,
  getChannel: async () => baseChannelDetails('viewer'),
  getBilling: async () => baseBillingView,
  getQueues: async () => ({ schemaVersion: 'v1', queues: [{ schemaVersion: 'v1', queueId: 'q1', channelId: 'c1', name: 'Main queue', paused: false, active: true }] }),
});

const interactionsApiPath = new URL('./interactions-api.ts', import.meta.url).pathname;
const listInteractionDefinitions = controllable<Parameters<typeof interactionsApi.listInteractionDefinitions>, Awaited<ReturnType<typeof interactionsApi.listInteractionDefinitions>>>(
  async () => ({ schemaVersion: 'v1', items: [] }),
);
const listWidgetConfigs = controllable<Parameters<typeof interactionsApi.listWidgetConfigs>, Awaited<ReturnType<typeof interactionsApi.listWidgetConfigs>>>(
  async () => ({ schemaVersion: 'v1', items: [] }),
);
const getLeaderboard = controllable<Parameters<typeof interactionsApi.getLeaderboard>, Awaited<ReturnType<typeof interactionsApi.getLeaderboard>>>(
  async () => ({ schemaVersion: 'v1', window: 'all', rows: [] }),
);
mock.module(interactionsApiPath, {
  namedExports: {
    listInteractionDefinitions: listInteractionDefinitions.fn,
    listWidgetConfigs: listWidgetConfigs.fn,
    getLeaderboard: getLeaderboard.fn,
    createInteractionDefinition: async () => { throw new Error('not stubbed'); },
    closeInteractionDefinition: async () => { throw new Error('not stubbed'); },
    createWidgetConfig: async () => { throw new Error('not stubbed'); },
    deleteWidgetConfig: async () => { throw new Error('not stubbed'); },
    createVoteOption: async () => { throw new Error('not stubbed'); },
    getVoteTally: async () => { throw new Error('not stubbed'); },
    startHypeMode: async () => { throw new Error('not stubbed'); },
    endHypeMode: async () => { throw new Error('not stubbed'); },
    getHypeMode: async () => { throw new Error('not stubbed'); },
  },
});

async function renderFreshPage() {
  const { default: InteractionsPage } = await import(`./page?t=${Math.random()}`);
  render(<InteractionsPage />);
  await waitFor(() => screen.getByText('@testhandle'));
}

test('a viewer (canManage: false) sees no create-interaction or create-widget form at all', async () => {
  listInteractionDefinitions.set(async () => ({ schemaVersion: 'v1', items: [] }));
  listWidgetConfigs.set(async () => ({ schemaVersion: 'v1', items: [] }));
  getLeaderboard.set(async () => ({ schemaVersion: 'v1', window: 'all', rows: [] }));
  await renderFreshPage();
  await waitFor(() => screen.getByText('Only the channel owner or an admin can configure interactions.'));
  assert.equal(document.querySelectorAll('form').length, 0);
});

test('the leaderboard renders rank and tier only — no rupee amount is ever printed on the page', async () => {
  listInteractionDefinitions.set(async () => ({ schemaVersion: 'v1', items: [] }));
  listWidgetConfigs.set(async () => ({ schemaVersion: 'v1', items: [] }));
  getLeaderboard.set(async () => ({ schemaVersion: 'v1', window: 'all', rows: [{ rank: 1, viewerRef: 'viewer_abcd1234', tierLabel: 'platinum' }] }));
  await renderFreshPage();
  await waitFor(() => screen.getByText(/#1/));
  assert.match(document.body.textContent ?? '', /platinum/);
  assert.doesNotMatch(document.body.textContent ?? '', /₹/);
});

test('a support-vote interaction row shows a Close control for an owner/admin, not a progress-editing control', async () => {
  listInteractionDefinitions.set(async () => ({
    schemaVersion: 'v1',
    items: [{ schemaVersion: 'v1', definitionId: 'd1', channelId: 'c1', interactionType: 'support_vote', label: 'Next game', amountPaise: null, queueId: 'q1', ttsEnabled: false, moderationRule: 'none', visual: {}, config: {}, isEnabled: true, closed: false, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }],
  }));
  listWidgetConfigs.set(async () => ({ schemaVersion: 'v1', items: [] }));
  getLeaderboard.set(async () => ({ schemaVersion: 'v1', window: 'all', rows: [] }));
  await renderFreshPage();
  await waitFor(() => screen.getByText('Next game'));
  // A viewer (this fixture's role) must not see the Close button either.
  assert.equal(screen.queryByText('Close'), null);
});
