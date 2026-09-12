import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, waitFor } from '@testing-library/react';
import { mockApi } from '../../test-support/mock-api';
import { baseBillingView } from '../../test-support/fixtures';

// BindingControls (defined inline in ./page.tsx, not its own module) is
// gated behind NEXT_PUBLIC_ENABLE_BINDINGS_UI, read once as a top-level
// const each time the page module is (re-)evaluated. The env var is set
// exactly once here, before any import of the page — this file only ever
// exercises the flag-off state (see binding-controls-enabled.test.tsx for
// flag-on coverage, kept in a separate file/process: reassigning this env
// var mid-process between two dynamic re-imports of the same page module
// was observed to wedge the second import's render indefinitely, so each
// flag state gets its own file instead of toggling the var in one file).
process.env.NEXT_PUBLIC_ENABLE_BINDINGS_UI = 'false';

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

mockApi({
  getAccessToken: () => 'fake-token',
  getTermsStatus: async () => ({ schemaVersion: 'v1', documents: [], accepted: true }),
  getBilling: async () => baseBillingView,
  getCurrentUser: async () => baseUser,
  getChannel: async () => baseChannel,
  getQueues: async () => ({ schemaVersion: 'v1', queues: [baseQueue] }),
  getChannelConfig: async () => baseConfig,
  getBindings: async () => ({ schemaVersion: 'v1', bindings: [] }),
});

test('with the bindings flag off, the routing section is not rendered at all — not hidden, absent', async () => {
  const { default: AlertsPage } = await import(`./page?t=${Math.random()}`);
  render(<AlertsPage />);
  await waitFor(() => screen.getByText('Main alerts'));
  assert.equal(screen.queryByRole('heading', { name: 'Choose where each source appears' }), null);
});
