import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { mockApi } from '../../test-support/mock-api';
import { controllable } from '../../test-support/controllable';
import type * as api from '../../lib/api';

const baseUser: api.CurrentUser = {
  schemaVersion: 'v1', userId: 'u1', displayName: 'Test Creator',
  channels: [{ channelId: 'c1', role: 'owner', payoutOnboardingDone: true }],
};
const baseSession: api.OverlaySession = { schemaVersion: 'v1', overlayId: 'ov1', expiresAt: '2026-03-01T00:00:00.000Z', streamUrl: 'https://overlay.example/s/ov1' };

const createSession = controllable<Parameters<typeof api.createOverlaySession>, Awaited<ReturnType<typeof api.createOverlaySession>>>(
  async () => baseSession,
);
const rotateSession = controllable<Parameters<typeof api.rotateOverlaySession>, Awaited<ReturnType<typeof api.rotateOverlaySession>>>(
  async () => ({ ...baseSession, overlayId: 'ov2', streamUrl: 'https://overlay.example/s/ov2' }),
);
const revokeSession = controllable<Parameters<typeof api.revokeOverlaySession>, Awaited<ReturnType<typeof api.revokeOverlaySession>>>(
  async () => undefined,
);

mockApi({
  getAccessToken: () => 'fake-token',
  getTermsStatus: async () => ({ schemaVersion: 'v1', documents: [], accepted: true }),
  getCurrentUser: async () => baseUser,
  getChannel: async () => ({ schemaVersion: 'v1', channelId: 'c1', handle: 'h', displayName: 'Test Channel', acceptingTips: true, publicConfigVersion: 1, featuredConsent: false, role: 'owner' }),
  getBilling: async () => ({ schemaVersion: 'v1', channelId: 'c1', tier: 'free', monthlyPricePaise: 0, annualMonthsCharged: 0, annualServiceMonths: 0, renewalState: 'not_applicable', nextRenewalAt: null, billingInterval: 'monthly', autoRenew: false, currentPeriodEndsAt: null, priceProtectedUntil: null, priceSource: 'current' }),
  createOverlaySession: createSession.fn,
  rotateOverlaySession: rotateSession.fn,
  revokeOverlaySession: revokeSession.fn,
});

async function renderFreshSetupPage() {
  const { default: OverlaySetupPage } = await import(`./page?t=${Math.random()}`);
  render(<OverlaySetupPage />);
  // Wait until the channel has loaded and "Create session" is actually
  // enabled — the button itself renders (disabled) before that.
  await waitFor(() => {
    const button = screen.getByRole('button', { name: 'Create session' }) as HTMLButtonElement;
    assert.equal(button.disabled, false);
  });
}

test('creating a session shows the stream URL and switches to rotate/revoke controls', async () => {
  createSession.set(async () => baseSession);
  await renderFreshSetupPage();
  fireEvent.click(screen.getByRole('button', { name: 'Create session' }));

  await waitFor(() => screen.getByDisplayValue('https://overlay.example/s/ov1'));
  assert.ok(screen.getByRole('button', { name: 'Rotate URL' }));
  assert.ok(screen.getByRole('button', { name: 'Revoke' }));
  assert.equal(screen.queryByRole('button', { name: 'Create session' }), null);
});

test('rotate requires confirmation, then replaces the URL — the old one is gone from the DOM', async () => {
  createSession.set(async () => baseSession);
  await renderFreshSetupPage();
  fireEvent.click(screen.getByRole('button', { name: 'Create session' }));
  await waitFor(() => screen.getByDisplayValue('https://overlay.example/s/ov1'));

  fireEvent.click(screen.getByRole('button', { name: 'Rotate URL' }));
  await waitFor(() => screen.getByText(/The current one stops working immediately/));
  rotateSession.set(async () => ({ ...baseSession, overlayId: 'ov2', streamUrl: 'https://overlay.example/s/ov2' }));
  fireEvent.click(screen.getByRole('button', { name: 'Yes, rotate' }));

  await waitFor(() => screen.getByDisplayValue('https://overlay.example/s/ov2'));
  assert.equal(screen.queryByDisplayValue('https://overlay.example/s/ov1'), null);
});

test('a failed create surfaces a specific error message and a sign-in link, and never renders a session', async () => {
  createSession.set(async () => { throw new Error('Overlay session could not be created'); });
  await renderFreshSetupPage();
  fireEvent.click(screen.getByRole('button', { name: 'Create session' }));

  await waitFor(() => screen.getByRole('alert'));
  assert.equal(screen.getByRole('alert').textContent, 'Overlay session could not be created');
  assert.ok(screen.getByRole('link', { name: /Return to sign in/ }));
  assert.equal(screen.queryByRole('button', { name: 'Rotate URL' }), null);
});

test('revoking a session, after confirmation, clears the session and returns to the Create session state', async () => {
  createSession.set(async () => baseSession);
  await renderFreshSetupPage();
  fireEvent.click(screen.getByRole('button', { name: 'Create session' }));
  await waitFor(() => screen.getByDisplayValue('https://overlay.example/s/ov1'));

  fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
  await waitFor(() => screen.getByText(/Your OBS browser source will stop showing alerts/));
  revokeSession.set(async () => undefined);
  fireEvent.click(screen.getByRole('button', { name: 'Yes, revoke' }));

  await waitFor(() => screen.getByRole('button', { name: 'Create session' }));
  assert.equal(screen.queryByDisplayValue('https://overlay.example/s/ov1'), null);
});
