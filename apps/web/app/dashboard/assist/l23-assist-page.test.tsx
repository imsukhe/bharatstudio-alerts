import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, waitFor } from '@testing-library/react';
import { mockApi } from '../../test-support/mock-api';
import { controllable } from '../../test-support/controllable';
import { baseBillingView, baseChannelDetails } from '../../test-support/fixtures';
import type * as api from '../../lib/api';
import type * as assistApi from './assist-api';

const baseUser: api.CurrentUser = {
  schemaVersion: 'v1', userId: 'u1', displayName: 'Test Creator',
  channels: [{ channelId: 'c1', role: 'owner', payoutOnboardingDone: true }],
};

const getChannel = controllable<Parameters<typeof api.getChannel>, Awaited<ReturnType<typeof api.getChannel>>>(
  async () => baseChannelDetails('owner'),
);
const getBilling = controllable<Parameters<typeof api.getBilling>, Awaited<ReturnType<typeof api.getBilling>>>(
  async () => ({ ...baseBillingView, tier: 'creator' }),
);

mockApi({
  getAccessToken: () => 'fake-token',
  getTermsStatus: async () => ({ schemaVersion: 'v1', documents: [], accepted: true }),
  getCurrentUser: async () => baseUser,
  getChannel: getChannel.fn,
  getBilling: getBilling.fn,
});

const assistApiPath = new URL('./assist-api.ts', import.meta.url).pathname;
const listAssistSuggestions = controllable<Parameters<typeof assistApi.listAssistSuggestions>, Awaited<ReturnType<typeof assistApi.listAssistSuggestions>>>(
  async () => ({ schemaVersion: 'v1', items: [] }),
);
const generateAssistSuggestion = controllable<Parameters<typeof assistApi.generateAssistSuggestion>, Awaited<ReturnType<typeof assistApi.generateAssistSuggestion>>>(
  async () => { throw new Error('generateAssistSuggestion not stubbed for this test'); },
);
const decideAssistSuggestion = controllable<Parameters<typeof assistApi.decideAssistSuggestion>, Awaited<ReturnType<typeof assistApi.decideAssistSuggestion>>>(
  async () => { throw new Error('decideAssistSuggestion not stubbed for this test'); },
);
const getAssistSuggestionAudit = controllable<Parameters<typeof assistApi.getAssistSuggestionAudit>, Awaited<ReturnType<typeof assistApi.getAssistSuggestionAudit>>>(
  async () => { throw new Error('getAssistSuggestionAudit not stubbed for this test'); },
);
mock.module(assistApiPath, {
  namedExports: {
    listAssistSuggestions: listAssistSuggestions.fn,
    generateAssistSuggestion: generateAssistSuggestion.fn,
    decideAssistSuggestion: decideAssistSuggestion.fn,
    getAssistSuggestionAudit: getAssistSuggestionAudit.fn,
  },
});

function fakeSuggestion(overrides: Partial<assistApi.AssistSuggestion> = {}): assistApi.AssistSuggestion {
  return {
    schemaVersion: 'v1', suggestionId: 's1', channelId: 'c1', surface: 'config', status: 'pending',
    suggestedPayload: { suggestedQueueMode: 'auto_advance' }, basis: 'rule: idle > 90s',
    requestedByUserId: 'u1', createdAt: '2026-09-01T00:00:00.000Z', decidedAt: null,
    ...overrides,
  };
}

async function renderFreshPage() {
  const { default: AssistPage } = await import(`./page?t=${Math.random()}`);
  render(<AssistPage />);
  await waitFor(() => screen.getByText('@testhandle') || screen.getByText(/AI assist/));
}

test('a paid-tier owner sees the request form and a pending suggestion is shown as a proposal, not applied', async () => {
  getChannel.set(async () => baseChannelDetails('owner'));
  getBilling.set(async () => ({ ...baseBillingView, tier: 'creator' }));
  listAssistSuggestions.set(async () => ({ schemaVersion: 'v1', items: [fakeSuggestion()] }));
  await renderFreshPage();
  await waitFor(() => screen.getByText('Proposed — not applied'));
  assert.ok(screen.getByText('Get a suggestion'));
});

test('a free-tier channel sees no request form and the entitlement explanation (an unentitled tier cannot generate suggestions)', async () => {
  getChannel.set(async () => baseChannelDetails('owner'));
  getBilling.set(async () => ({ ...baseBillingView, tier: 'free' }));
  listAssistSuggestions.set(async () => ({ schemaVersion: 'v1', items: [] }));
  await renderFreshPage();
  await waitFor(() => screen.getByText('AI assist is not available on the free tier.'));
  assert.equal(screen.queryByText('Get a suggestion'), null);
});

test('a viewer cannot decide a config suggestion: no Accept/Reject controls render, only the role explanation (the human gate is role-checked client-side too, though the server is authoritative)', async () => {
  getChannel.set(async () => baseChannelDetails('viewer'));
  getBilling.set(async () => ({ ...baseBillingView, tier: 'creator' }));
  listAssistSuggestions.set(async () => ({ schemaVersion: 'v1', items: [fakeSuggestion()] }));
  await renderFreshPage();
  await waitFor(() => screen.getByText('Only owner/admin can decide this suggestion.'));
  assert.equal(screen.queryByText('Accept'), null);
  assert.equal(screen.queryByText('Reject'), null);
});

test('accepting a suggestion calls decideAssistSuggestion with "accepted" and never renders it as already applied to the live surface', async () => {
  getChannel.set(async () => baseChannelDetails('owner'));
  getBilling.set(async () => ({ ...baseBillingView, tier: 'creator' }));
  listAssistSuggestions.set(async () => ({ schemaVersion: 'v1', items: [fakeSuggestion()] }));
  let calledWith: unknown;
  decideAssistSuggestion.set(async (_channelId, _suggestionId, input) => {
    calledWith = input;
    return { schemaVersion: 'v1', confirmationId: 'conf1', suggestionId: 's1', decision: 'accepted', decidedByUserId: 'u1', decidedByRole: 'owner', appliedPayload: { suggestedQueueMode: 'auto_advance' }, decidedAt: '2026-09-01T00:05:00.000Z' };
  });
  await renderFreshPage();
  await waitFor(() => screen.getByText('Accept'));
  screen.getByText('Accept').click();
  await waitFor(() => assert.deepEqual(calledWith, { decision: 'accepted' }));
  await waitFor(() => screen.getByText(/apply it on its own screen/i));
});

test('rejecting a suggestion calls decideAssistSuggestion with "rejected" (rejection is recorded, not just discarded)', async () => {
  getChannel.set(async () => baseChannelDetails('owner'));
  getBilling.set(async () => ({ ...baseBillingView, tier: 'creator' }));
  listAssistSuggestions.set(async () => ({ schemaVersion: 'v1', items: [fakeSuggestion()] }));
  let calledWith: unknown;
  decideAssistSuggestion.set(async (_channelId, _suggestionId, input) => {
    calledWith = input;
    return { schemaVersion: 'v1', confirmationId: 'conf1', suggestionId: 's1', decision: 'rejected', decidedByUserId: 'u1', decidedByRole: 'owner', appliedPayload: null, decidedAt: '2026-09-01T00:05:00.000Z' };
  });
  await renderFreshPage();
  await waitFor(() => screen.getByText('Reject'));
  screen.getByText('Reject').click();
  await waitFor(() => assert.deepEqual(calledWith, { decision: 'rejected' }));
  await waitFor(() => screen.getByText('Suggestion rejected and recorded.'));
});

test('a decided suggestion offers an audit-trail view that shows who decided and when', async () => {
  getChannel.set(async () => baseChannelDetails('owner'));
  getBilling.set(async () => ({ ...baseBillingView, tier: 'creator' }));
  listAssistSuggestions.set(async () => ({ schemaVersion: 'v1', items: [fakeSuggestion({ status: 'accepted', decidedAt: '2026-09-01T00:05:00.000Z' })] }));
  getAssistSuggestionAudit.set(async () => ({
    ...fakeSuggestion({ status: 'accepted', decidedAt: '2026-09-01T00:05:00.000Z' }),
    confirmation: { schemaVersion: 'v1', confirmationId: 'conf1', suggestionId: 's1', decision: 'accepted', decidedByUserId: 'u1', decidedByRole: 'owner', appliedPayload: { suggestedQueueMode: 'auto_advance' }, decidedAt: '2026-09-01T00:05:00.000Z' },
  }));
  await renderFreshPage();
  await waitFor(() => screen.getByText('View audit trail'));
  screen.getByText('View audit trail').click();
  await waitFor(() => screen.getByText(/Accepted by owner on/));
});
