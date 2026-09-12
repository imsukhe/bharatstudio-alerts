import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, waitFor } from '@testing-library/react';
import { mockApi } from '../../test-support/mock-api';
import { controllable } from '../../test-support/controllable';
import { baseBillingView, baseChannelDetails } from '../../test-support/fixtures';
import type * as api from '../../lib/api';
import type * as goalsApi from './goals-api';

/*
 * Progress is server-computed from confirmed payments only (see
 * GoalsPanel.tsx's own comment and goals/page.tsx's helper text) — this
 * file exists to prove that as an executable regression test, not just a
 * comment: an owner's create form has NO numeric field that could set
 * progressPaise, and the rendered progress bar carries no interactive
 * control at all. A regression that added a "set progress" input would be
 * a real product bug (fake-able tip totals) and would fail this test.
 */

const baseUser: api.CurrentUser = {
  schemaVersion: 'v1', userId: 'u1', displayName: 'Test Creator',
  channels: [{ channelId: 'c1', role: 'owner', payoutOnboardingDone: true }],
};

mockApi({
  getAccessToken: () => 'fake-token',
  getTermsStatus: async () => ({ schemaVersion: 'v1', documents: [], accepted: true }),
  getCurrentUser: async () => baseUser,
  getChannel: async () => baseChannelDetails('owner'),
  getBilling: async () => baseBillingView,
});

const goalsApiPath = new URL('./goals-api.ts', import.meta.url).pathname;
const listGoals = controllable<Parameters<typeof goalsApi.listGoals>, Awaited<ReturnType<typeof goalsApi.listGoals>>>(
  async () => ({ schemaVersion: 'v1', items: [] }),
);
mock.module(goalsApiPath, {
  namedExports: {
    listGoals: listGoals.fn,
    createGoal: async () => { throw new Error('not stubbed'); },
    endGoal: async () => { throw new Error('not stubbed'); },
    updateGoal: async () => { throw new Error('not stubbed'); },
  },
});

async function renderFreshPage() {
  const { default: GoalsPage } = await import(`./page?t=${Math.random()}`);
  render(<GoalsPage />);
  await waitFor(() => screen.getByText('@testhandle'));
}

test('the owner create form has exactly the title/target/window/public fields — no progress input exists anywhere on the page', async () => {
  listGoals.set(async () => ({ schemaVersion: 'v1', items: [] }));
  await renderFreshPage();
  await waitFor(() => screen.getByPlaceholderText('New PC fund'));

  // The only text/number inputs on the whole page are the goal-creation
  // fields (title + target amount) — never anything resembling a progress
  // or "current amount" field.
  const inputs = Array.from(document.querySelectorAll('input')).filter((el) => el.type !== 'checkbox');
  const placeholders = inputs.map((el) => el.placeholder);
  assert.deepEqual(placeholders.sort(), ['10000', 'New PC fund']);
});

test('a goal\'s rendered progress bar is a non-interactive, read-only indicator (no input/button lets you change its value directly)', async () => {
  listGoals.set(async () => ({
    schemaVersion: 'v1',
    items: [{ schemaVersion: 'v1', goalId: 'g1', channelId: 'c1', title: 'Camera fund', targetAmountPaise: 1_000_000, window: 'open', isPublic: true, progressPaise: 400_000, reached: false, ended: false, startedAt: '2026-09-01T00:00:00.000Z', endedAt: null }],
  }));
  await renderFreshPage();
  await waitFor(() => screen.getByText('Camera fund'));

  const progressBar = screen.getByRole('progressbar');
  assert.equal(progressBar.getAttribute('aria-valuenow'), '40');
  // A progressbar is display-only by ARIA semantics; assert there is no
  // input/button nested inside it that could adjust the value.
  assert.equal(progressBar.querySelectorAll('input, button').length, 0);
  // The only button on this goal's row is "End goal" (a lifecycle action),
  // never anything that edits progress.
  const listItem = progressBar.closest('.goals-list-item') as HTMLElement;
  const buttonLabels = Array.from(listItem.querySelectorAll('button')).map((btn) => btn.textContent);
  assert.deepEqual(buttonLabels, ['End goal']);
});
