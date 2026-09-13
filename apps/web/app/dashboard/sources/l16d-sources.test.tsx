import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mockApi } from '../../test-support/mock-api';
import { controllable } from '../../test-support/controllable';
import { baseBillingView, baseChannelDetails } from '../../test-support/fixtures';
import type * as api from '../../lib/api';
import type * as goalsApi from '../goals/goals-api';
import type * as challengesApi from '../challenges/challenges-api';
import type * as interactionsApi from '../interactions/interactions-api';
import type * as sourcesApi from './sources-api';

/*
 * L16c (0117) contribution-source-selection UI. Proves:
 *  - a creator can toggle each known source per goal/challenge/interaction,
 *    and the toggle round-trips through the real setSourceInclusion/
 *    listSourceInclusions endpoints with the exact args the API expects;
 *  - a missing source row reads back as included (0117's own default);
 *  - NO percentage/multiplier control exists anywhere on the page — the
 *    only controls are checkboxes, and the page never renders a "%"
 *    character or a numeric weight input. See sources-api.ts and
 *    SourcesPanel.tsx's own headers for why: BharatStudio cannot compute a
 *    correct net rate for a Super Chat, so offering a multiplier would
 *    present our arithmetic on someone else's money as fact.
 *  - a non-owner/admin never sees the manage controls at all.
 */

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

const goalsApiPath = new URL('../goals/goals-api.ts', import.meta.url).pathname;
const challengesApiPath = new URL('../challenges/challenges-api.ts', import.meta.url).pathname;
const interactionsApiPath = new URL('../interactions/interactions-api.ts', import.meta.url).pathname;
const sourcesApiPath = new URL('./sources-api.ts', import.meta.url).pathname;

const listGoals = controllable<Parameters<typeof goalsApi.listGoals>, Awaited<ReturnType<typeof goalsApi.listGoals>>>(
  async () => ({ schemaVersion: 'v1', items: [] }),
);
const listChallenges = controllable<Parameters<typeof challengesApi.listChallenges>, Awaited<ReturnType<typeof challengesApi.listChallenges>>>(
  async () => ({ schemaVersion: 'v1', failureCopy: '', items: [] }),
);
const listInteractionDefinitions = controllable<Parameters<typeof interactionsApi.listInteractionDefinitions>, Awaited<ReturnType<typeof interactionsApi.listInteractionDefinitions>>>(
  async () => ({ schemaVersion: 'v1', items: [] }),
);
const listSourceInclusions = controllable<Parameters<typeof sourcesApi.listSourceInclusions>, Awaited<ReturnType<typeof sourcesApi.listSourceInclusions>>>(
  async () => ({ schemaVersion: 'v1', sources: [] }),
);
const setSourceInclusionCalls: unknown[][] = [];
const setSourceInclusion = controllable<Parameters<typeof sourcesApi.setSourceInclusion>, Awaited<ReturnType<typeof sourcesApi.setSourceInclusion>>>(
  async () => ({ schemaVersion: 'v1', sources: [{ sourceType: 'youtube_superchat', included: false }] }),
);

mock.module(goalsApiPath, { namedExports: { listGoals: listGoals.fn, createGoal: async () => { throw new Error('not stubbed'); }, updateGoal: async () => { throw new Error('not stubbed'); }, endGoal: async () => { throw new Error('not stubbed'); } } });
mock.module(challengesApiPath, { namedExports: { listChallenges: listChallenges.fn, createChallenge: async () => { throw new Error('not stubbed'); }, transitionChallenge: async () => { throw new Error('not stubbed'); } } });
mock.module(interactionsApiPath, {
  namedExports: {
    listInteractionDefinitions: listInteractionDefinitions.fn,
    createInteractionDefinition: async () => { throw new Error('not stubbed'); },
    closeInteractionDefinition: async () => { throw new Error('not stubbed'); },
    createVoteOption: async () => { throw new Error('not stubbed'); },
    getVoteTally: async () => { throw new Error('not stubbed'); },
    startHypeMode: async () => { throw new Error('not stubbed'); },
    endHypeMode: async () => { throw new Error('not stubbed'); },
    getHypeMode: async () => { throw new Error('not stubbed'); },
    listWidgetConfigs: async () => { throw new Error('not stubbed'); },
    createWidgetConfig: async () => { throw new Error('not stubbed'); },
    deleteWidgetConfig: async () => { throw new Error('not stubbed'); },
    getLeaderboard: async () => { throw new Error('not stubbed'); },
  },
});
mock.module(sourcesApiPath, {
  namedExports: {
    listSourceInclusions: listSourceInclusions.fn,
    setSourceInclusion: (...args: Parameters<typeof sourcesApi.setSourceInclusion>) => { setSourceInclusionCalls.push(args); return setSourceInclusion.fn(...args); },
  },
});

async function renderFreshPage() {
  const { default: SourcesPage } = await import(`./page?t=${Math.random()}`);
  render(<SourcesPage />);
  await waitFor(() => screen.getByText('@testhandle'));
}

test('a missing source row reads back as included, and toggling it off round-trips through setSourceInclusion with the exact args', async () => {
  getChannel.set(async () => baseChannelDetails('owner'));
  listGoals.set(async () => ({ schemaVersion: 'v1', items: [{ schemaVersion: 'v1', goalId: 'g1', channelId: 'c1', title: 'Camera fund', targetAmountPaise: 1_000_000, window: 'open', isPublic: true, progressPaise: 0, reached: false, ended: false, startedAt: '2026-09-01T00:00:00.000Z', endedAt: null }] }));
  listChallenges.set(async () => ({ schemaVersion: 'v1', failureCopy: '', items: [] }));
  listInteractionDefinitions.set(async () => ({ schemaVersion: 'v1', items: [] }));
  listSourceInclusions.set(async () => ({ schemaVersion: 'v1', sources: [] })); // no rows = both included
  setSourceInclusionCalls.length = 0;
  setSourceInclusion.set(async () => ({ schemaVersion: 'v1', sources: [{ sourceType: 'youtube_superchat', included: false }] }));

  await renderFreshPage();
  await waitFor(() => screen.getByText('Camera fund'));
  fireEvent.click(screen.getByRole('button', { name: 'Manage sources' }));
  await waitFor(() => screen.getByLabelText('YouTube Super Chats'));

  const paymentCheckbox = screen.getByLabelText('BharatStudio tips') as HTMLInputElement;
  const superChatCheckbox = screen.getByLabelText('YouTube Super Chats') as HTMLInputElement;
  assert.equal(paymentCheckbox.checked, true);
  assert.equal(superChatCheckbox.checked, true);

  fireEvent.click(superChatCheckbox);
  await waitFor(() => assert.equal(setSourceInclusionCalls.length, 1));
  assert.deepEqual(setSourceInclusionCalls[0], ['c1', 'goal', 'g1', 'youtube_superchat', false]);
});

test('no percentage or numeric-weight control exists anywhere on the page — only checkboxes, and no "%" is ever rendered', async () => {
  getChannel.set(async () => baseChannelDetails('owner'));
  listGoals.set(async () => ({ schemaVersion: 'v1', items: [{ schemaVersion: 'v1', goalId: 'g1', channelId: 'c1', title: 'Camera fund', targetAmountPaise: 1_000_000, window: 'open', isPublic: true, progressPaise: 0, reached: false, ended: false, startedAt: '2026-09-01T00:00:00.000Z', endedAt: null }] }));
  listChallenges.set(async () => ({ schemaVersion: 'v1', failureCopy: '', items: [] }));
  listInteractionDefinitions.set(async () => ({ schemaVersion: 'v1', items: [] }));
  listSourceInclusions.set(async () => ({ schemaVersion: 'v1', sources: [] }));

  await renderFreshPage();
  await waitFor(() => screen.getByText('Camera fund'));
  fireEvent.click(screen.getByRole('button', { name: 'Manage sources' }));
  await waitFor(() => screen.getByLabelText('YouTube Super Chats'));

  const inputs = Array.from(document.querySelectorAll('input'));
  assert.ok(inputs.length > 0);
  assert.ok(inputs.every((el) => el.type === 'checkbox'));
  assert.equal(document.body.textContent?.includes('%'), false);
  assert.ok(screen.getByText(/Shown as the full amount YouTube reports/));
});

test('a non-owner/admin sees only the read-only explanation, never a Manage sources control', async () => {
  getChannel.set(async () => baseChannelDetails('viewer'));
  listGoals.set(async () => ({ schemaVersion: 'v1', items: [{ schemaVersion: 'v1', goalId: 'g1', channelId: 'c1', title: 'Camera fund', targetAmountPaise: 1_000_000, window: 'open', isPublic: true, progressPaise: 0, reached: false, ended: false, startedAt: '2026-09-01T00:00:00.000Z', endedAt: null }] }));
  listChallenges.set(async () => ({ schemaVersion: 'v1', failureCopy: '', items: [] }));
  listInteractionDefinitions.set(async () => ({ schemaVersion: 'v1', items: [] }));

  await renderFreshPage();
  await waitFor(() => screen.getByText('Only the channel owner or an admin can choose which contribution sources count toward a target.'));
  assert.equal(screen.queryByText('Manage sources'), null);
});
