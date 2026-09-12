import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, waitFor } from '@testing-library/react';
import { mockApi } from '../../test-support/mock-api';
import { controllable } from '../../test-support/controllable';
import { baseBillingView, baseChannelDetails } from '../../test-support/fixtures';
import type * as api from '../../lib/api';
import type * as challengesApi from './challenges-api';

const FAILURE_COPY = 'Contributing to a challenge is a tip to the creator, not an escrowed payment — BharatStudio holds no funds and cannot issue a refund. If this challenge fails or is cancelled, your contribution stays with the creator; only the creator can refund you, and only from their own connected payment provider.';

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

const challengesApiPath = new URL('./challenges-api.ts', import.meta.url).pathname;
const listChallenges = controllable<Parameters<typeof challengesApi.listChallenges>, Awaited<ReturnType<typeof challengesApi.listChallenges>>>(
  async () => ({ schemaVersion: 'v1', failureCopy: FAILURE_COPY, items: [] }),
);
const createChallenge = controllable<Parameters<typeof challengesApi.createChallenge>, Awaited<ReturnType<typeof challengesApi.createChallenge>>>(
  async () => { throw new Error('createChallenge not stubbed for this test'); },
);
const transitionChallenge = controllable<Parameters<typeof challengesApi.transitionChallenge>, Awaited<ReturnType<typeof challengesApi.transitionChallenge>>>(
  async () => { throw new Error('transitionChallenge not stubbed for this test'); },
);
mock.module(challengesApiPath, {
  namedExports: { listChallenges: listChallenges.fn, createChallenge: createChallenge.fn, transitionChallenge: transitionChallenge.fn },
});

async function renderFreshPage() {
  const { default: ChallengesPage } = await import(`./page?t=${Math.random()}`);
  render(<ChallengesPage />);
  await waitFor(() => screen.getByText('@testhandle'));
}

test('an owner sees the honest failure copy and the create form', async () => {
  getChannel.set(async () => baseChannelDetails('owner'));
  listChallenges.set(async () => ({ schemaVersion: 'v1', failureCopy: FAILURE_COPY, items: [] }));
  await renderFreshPage();
  await waitFor(() => screen.getByText('No challenges yet.'));
  assert.ok(screen.getByText(FAILURE_COPY));
  assert.ok(screen.getByPlaceholderText('Shave my head at ₹5,000'));
});

test('a viewer sees no create form, only the read-only explanation, but still sees the failure copy', async () => {
  getChannel.set(async () => baseChannelDetails('viewer'));
  listChallenges.set(async () => ({ schemaVersion: 'v1', failureCopy: FAILURE_COPY, items: [] }));
  await renderFreshPage();
  await waitFor(() => screen.getByText('Only the channel owner or an admin can create or manage challenges.'));
  await waitFor(() => screen.getByText(FAILURE_COPY));
  assert.equal(screen.queryByPlaceholderText('Shave my head at ₹5,000'), null);
  assert.ok(screen.getByText(FAILURE_COPY));
});

test('a draft challenge shows Start/Cancel actions; an active one shows succeeded/failed/cancel; a terminal one shows none', async () => {
  getChannel.set(async () => baseChannelDetails('owner'));
  listChallenges.set(async () => ({
    schemaVersion: 'v1', failureCopy: FAILURE_COPY,
    items: [
      { schemaVersion: 'v1', challengeId: 'ch1', channelId: 'c1', title: 'Draft challenge', description: null, kind: 'stake', targetAmountPaise: 500_000, state: 'draft', isPublic: true, progressPaise: 0, targetReached: false, startedAt: null, endedAt: null, createdAt: '2026-09-01T00:00:00.000Z' },
      { schemaVersion: 'v1', challengeId: 'ch2', channelId: 'c1', title: 'Active bounty', description: null, kind: 'bounty', targetAmountPaise: 500_000, state: 'active', isPublic: true, progressPaise: 250_000, targetReached: false, startedAt: '2026-09-01T00:00:00.000Z', endedAt: null, createdAt: '2026-09-01T00:00:00.000Z' },
      { schemaVersion: 'v1', challengeId: 'ch3', channelId: 'c1', title: 'Failed stake', description: null, kind: 'stake', targetAmountPaise: 500_000, state: 'failed', isPublic: true, progressPaise: 100_000, targetReached: false, startedAt: '2026-09-01T00:00:00.000Z', endedAt: '2026-09-02T00:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z' },
    ],
  }));
  await renderFreshPage();
  await waitFor(() => screen.getByText('Draft challenge'));
  assert.ok(screen.getByText('Start'));
  assert.ok(screen.getByText('Mark succeeded'));
  assert.ok(screen.getByText('Mark failed'));
  assert.equal(screen.getAllByText('Cancel').length, 2); // draft + active, never the failed one
  assert.ok(screen.getByText('Did not happen'));
});
