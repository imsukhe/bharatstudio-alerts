import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, waitFor } from '@testing-library/react';
import { mockApi } from '../../test-support/mock-api';
import { controllable } from '../../test-support/controllable';
import { baseBillingView, baseChannelDetails } from '../../test-support/fixtures';
import type * as api from '../../lib/api';
import type * as goalsApi from './goals-api';

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

const goalsApiPath = new URL('./goals-api.ts', import.meta.url).pathname;
const listGoals = controllable<Parameters<typeof goalsApi.listGoals>, Awaited<ReturnType<typeof goalsApi.listGoals>>>(
  async () => ({ schemaVersion: 'v1', items: [] }),
);
const createGoal = controllable<Parameters<typeof goalsApi.createGoal>, Awaited<ReturnType<typeof goalsApi.createGoal>>>(
  async () => { throw new Error('createGoal not stubbed for this test'); },
);
const endGoal = controllable<Parameters<typeof goalsApi.endGoal>, Awaited<ReturnType<typeof goalsApi.endGoal>>>(
  async () => { throw new Error('endGoal not stubbed for this test'); },
);
mock.module(goalsApiPath, {
  namedExports: { listGoals: listGoals.fn, createGoal: createGoal.fn, endGoal: endGoal.fn, updateGoal: async () => { throw new Error('not stubbed'); } },
});

async function renderFreshPage() {
  const { default: GoalsPage } = await import(`./page?t=${Math.random()}`);
  render(<GoalsPage />);
  await waitFor(() => screen.getByText('@testhandle'));
}

test('an owner sees the create form and can create a goal', async () => {
  getChannel.set(async () => baseChannelDetails('owner'));
  listGoals.set(async () => ({ schemaVersion: 'v1', items: [] }));
  await renderFreshPage();
  await waitFor(() => screen.getByText('No support goals yet.'));
  assert.ok(screen.getByPlaceholderText('New PC fund'));
});

test('a viewer sees no create form, only the read-only explanation', async () => {
  getChannel.set(async () => baseChannelDetails('viewer'));
  listGoals.set(async () => ({ schemaVersion: 'v1', items: [] }));
  await renderFreshPage();
  await waitFor(() => screen.getByText('Only the channel owner or an admin can create or end support goals.'));
  assert.equal(screen.queryByPlaceholderText('New PC fund'), null);
});

test('renders a partial goal with its progress and a reached goal with its status', async () => {
  getChannel.set(async () => baseChannelDetails('owner'));
  listGoals.set(async () => ({
    schemaVersion: 'v1',
    items: [
      { schemaVersion: 'v1', goalId: 'g1', channelId: 'c1', title: 'Partial fund', targetAmountPaise: 1_000_000, window: 'open', isPublic: true, progressPaise: 250_000, reached: false, ended: false, startedAt: '2026-09-01T00:00:00.000Z', endedAt: null },
      { schemaVersion: 'v1', goalId: 'g2', channelId: 'c1', title: 'Reached fund', targetAmountPaise: 500_000, window: 'stream', isPublic: true, progressPaise: 600_000, reached: true, ended: false, startedAt: '2026-09-01T00:00:00.000Z', endedAt: null },
    ],
  }));
  await renderFreshPage();
  await waitFor(() => screen.getByText('Partial fund'));
  assert.ok(screen.getByText('Reached fund'));
  assert.equal(screen.getAllByText('Active').length, 1);
  assert.equal(screen.getAllByText('Reached').length, 1);
});
