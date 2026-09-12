import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { mockApi } from '../../test-support/mock-api';
import { controllable } from '../../test-support/controllable';
import type * as api from '../../lib/api';
import { baseBillingView } from '../../test-support/fixtures';

// BindingControls (defined inline in ./page.tsx, not its own module) is
// gated behind NEXT_PUBLIC_ENABLE_BINDINGS_UI, read once as a top-level
// const each time the page module is (re-)evaluated. The env var is set
// exactly once here, before any import of the page — this file only ever
// exercises the flag-on state (see binding-controls-disabled.test.tsx for
// flag-off coverage, kept in a separate file/process: reassigning this env
// var mid-process between two dynamic re-imports of the same page module
// was observed to wedge the second import's render indefinitely, so each
// flag state gets its own file instead of toggling the var in one file).
process.env.NEXT_PUBLIC_ENABLE_BINDINGS_UI = 'true';

const baseUser = {
  schemaVersion: 'v1' as const,
  userId: 'u1',
  displayName: 'Test Creator',
  channels: [{ channelId: 'c1', role: 'operator' as const, payoutOnboardingDone: true }],
};

const baseChannel = {
  schemaVersion: 'v1' as const,
  channelId: 'c1',
  handle: 'testhandle',
  displayName: 'Test Channel',
  acceptingTips: true,
  publicConfigVersion: 1,
  featuredConsent: false,
  role: 'operator' as const,
};

const baseConfig = {
  schemaVersion: 'v1' as const,
  channelId: 'c1',
  version: 1,
  values: {},
  effectiveAt: '2026-01-01T00:00:00.000Z',
};

const baseQueue = { schemaVersion: 'v1' as const, queueId: 'q1', channelId: 'c1', name: 'Main alerts', paused: false, active: true };

const existingBinding = {
  schemaVersion: 'v1' as const,
  bindingId: 'b1',
  channelId: 'c1',
  queueId: 'q1',
  sourceType: 'payment' as const,
  sourceId: '__channel_default__',
  allowDuplicates: false,
  priority: 0,
  overrideValues: null,
  active: true,
};

const createBinding = controllable<Parameters<typeof api.createBinding>, Awaited<ReturnType<typeof api.createBinding>>>(
  async () => { throw new Error('createBinding not stubbed for this test'); },
);

mockApi({
  getAccessToken: () => 'fake-token',
  getTermsStatus: async () => ({ schemaVersion: 'v1', documents: [], accepted: true }),
  getBilling: async () => baseBillingView,
  getCurrentUser: async () => baseUser,
  getChannel: async () => baseChannel,
  getQueues: async () => ({ schemaVersion: 'v1', queues: [baseQueue] }),
  getChannelConfig: async () => baseConfig,
  getBindings: async () => ({ schemaVersion: 'v1', bindings: [existingBinding] }),
  createBinding: createBinding.fn,
});

async function renderFreshAlertsPage() {
  const { default: AlertsPage } = await import(`./page?t=${Math.random()}`);
  render(<AlertsPage />);
  await waitFor(() => screen.getByText('@testhandle'));
}

test('with the bindings flag on, an operator sees the routing section and its existing binding', async () => {
  await renderFreshAlertsPage();
  await waitFor(() => screen.getByRole('heading', { name: 'Choose where each source appears' }));
  assert.ok(screen.getByText('New payments (default)'));
});

test('creating a binding for a source type the channel is not entitled to is refused by the server and never added to the list optimistically', async () => {
  createBinding.set(async () => { throw new Error('Your plan does not include Companion routing.'); });
  await renderFreshAlertsPage();
  await waitFor(() => screen.getByRole('heading', { name: 'Choose where each source appears' }));

  fireEvent.change(screen.getByLabelText('Source type'), { target: { value: 'companion' } });
  fireEvent.change(screen.getByLabelText('Source ID'), { target: { value: 'companion-widget-1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add binding' }));

  await waitFor(() => screen.getByText('Your plan does not include Companion routing.'));
  // Only the pre-existing default binding is present — the rejected
  // "companion-widget-1" row was never optimistically inserted.
  assert.equal(screen.queryByText('companion-widget-1'), null);
  assert.equal(screen.getAllByText(/priority/).length, 1);
});

test('successfully creating a binding prepends it to the list and clears the source-id field for the next entry', async () => {
  const created = { ...existingBinding, bindingId: 'b2', sourceType: 'manual' as const, sourceId: 'manual-entry-1' };
  createBinding.set(async () => created);
  await renderFreshAlertsPage();
  await waitFor(() => screen.getByRole('heading', { name: 'Choose where each source appears' }));

  fireEvent.change(screen.getByLabelText('Source type'), { target: { value: 'manual' } });
  fireEvent.change(screen.getByLabelText('Source ID'), { target: { value: 'manual-entry-1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add binding' }));

  await waitFor(() => screen.getByText('manual-entry-1'));
  assert.ok(screen.getByText('Routing binding created for future events.'));
  assert.equal((screen.getByLabelText('Source ID') as HTMLInputElement).value, '');
});
