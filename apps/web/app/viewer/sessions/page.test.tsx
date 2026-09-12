import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { mockViewerApi } from '../../test-support/mock-viewer-api';
import { controllable } from '../../test-support/controllable';
import type * as viewerApi from '../lib/viewer-api';

const baseSessions: viewerApi.ViewerSessionSummary[] = [
  { sessionId: 's-current', createdAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-05T00:00:00.000Z', expiresAt: '2026-02-01T00:00:00.000Z', deviceLabel: 'This browser', current: true },
  { sessionId: 's-other', createdAt: '2026-01-02T00:00:00.000Z', lastSeenAt: '2026-01-04T00:00:00.000Z', expiresAt: '2026-02-02T00:00:00.000Z', deviceLabel: 'Old phone', current: false },
];

const getSessions = controllable<Parameters<typeof viewerApi.getViewerSessions>, Awaited<ReturnType<typeof viewerApi.getViewerSessions>>>(
  async () => baseSessions,
);
const revokeSession = controllable<Parameters<typeof viewerApi.revokeViewerSession>, Awaited<ReturnType<typeof viewerApi.revokeViewerSession>>>(
  async () => undefined,
);

mockViewerApi({ getViewerSessions: getSessions.fn, revokeViewerSession: revokeSession.fn });

async function renderFreshSessionsPage() {
  const { default: ViewerSessionsPage } = await import(`./page?t=${Math.random()}`);
  render(<ViewerSessionsPage />);
  await waitFor(() => screen.getByText('Old phone'));
}

test('the current session never gets a Revoke button — only other sessions do', async () => {
  getSessions.set(async () => baseSessions);
  await renderFreshSessionsPage();
  // Exactly one Revoke button exists (for the non-current session).
  assert.equal(screen.getAllByRole('button', { name: 'Revoke' }).length, 1);
  const currentRow = screen.getByText('This browser · current').closest('.session-row')!;
  assert.equal(currentRow.querySelector('button'), null);
});

test('revoking a non-current session calls revokeViewerSession with THAT session\'s id, and removes only that row', async () => {
  getSessions.set(async () => baseSessions);
  await renderFreshSessionsPage();
  let revokedId: string | undefined;
  revokeSession.set(async (sessionId) => { revokedId = sessionId; });

  fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));

  await waitFor(() => screen.getByText('Session revoked'));
  assert.equal(revokedId, 's-other', 'must revoke the clicked session, never the current one, and never the wrong id');
  assert.equal(screen.queryByText('Old phone'), null);
  // The current session's row must still be present — only the target
  // session was removed from the list.
  assert.ok(screen.getByText('This browser · current'));
});

test('a failed revoke shows an error via StatusMessage and leaves the session in the list (no false removal)', async () => {
  getSessions.set(async () => baseSessions);
  await renderFreshSessionsPage();
  revokeSession.set(async () => { throw new Error('Could not revoke that session'); });

  fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));

  await waitFor(() => screen.getByRole('alert'));
  assert.equal(screen.getByRole('alert').textContent, 'Could not revoke that session');
  assert.ok(screen.getByText('Old phone'), 'a failed revoke must not remove the session from the list');
});

test('an unnamed device (deviceLabel: null) still renders without crashing', async () => {
  getSessions.set(async () => [{ ...baseSessions[1], deviceLabel: null }]);
  const { default: ViewerSessionsPage } = await import(`./page?t=${Math.random()}`);
  render(<ViewerSessionsPage />);
  await waitFor(() => screen.getByText('Unnamed device'));
});
