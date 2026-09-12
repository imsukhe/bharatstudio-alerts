import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { mockViewerApi } from '../../test-support/mock-viewer-api';
import { controllable } from '../../test-support/controllable';
import type * as viewerApi from '../lib/viewer-api';

const deletion = controllable<Parameters<typeof viewerApi.requestViewerAccountDeletion>, Awaited<ReturnType<typeof viewerApi.requestViewerAccountDeletion>>>(
  async () => ({ erased: ['profile', 'login credentials'], retained: ['financial records (payments, refunds)'], legalDispositionOpen: true }),
);
let clearedCount = 0;

mockViewerApi({
  requestViewerAccountDeletion: deletion.fn,
  clearViewerAccessToken: () => { clearedCount += 1; },
});

test('this page renders the viewer\'s own chrome, never the creator AppShell/TopNav', async () => {
  const { default: ViewerDeleteAccountPage } = await import(`./page?t=${Math.random()}`);
  render(<ViewerDeleteAccountPage />);
  assert.equal(screen.queryByText('Companion'), null);
  assert.equal(screen.queryByRole('link', { name: 'Payments' }), null);
});

test('the delete button stays disabled until the exact confirmation text DELETE is typed', async () => {
  const { default: ViewerDeleteAccountPage } = await import(`./page?t=${Math.random()}`);
  render(<ViewerDeleteAccountPage />);
  const button = screen.getByRole('button', { name: 'Delete my account' }) as HTMLButtonElement;
  assert.equal(button.disabled, true);

  fireEvent.change(screen.getByLabelText('Type DELETE to confirm'), { target: { value: 'delete' } });
  assert.equal(button.disabled, true, 'lowercase must not satisfy the exact-match confirmation');

  fireEvent.change(screen.getByLabelText('Type DELETE to confirm'), { target: { value: 'DELETE' } });
  assert.equal(button.disabled, false);
});

test('after a successful request, the page states plainly what is erased vs retained — financial records are named as retained by design (migration 0085)', async () => {
  deletion.set(async () => ({
    erased: ['profile', 'login credentials', 'display name'],
    retained: ['financial records (payments, refunds)'],
    legalDispositionOpen: true,
  }));
  const { default: ViewerDeleteAccountPage } = await import(`./page?t=${Math.random()}`);
  render(<ViewerDeleteAccountPage />);

  fireEvent.change(screen.getByLabelText('Type DELETE to confirm'), { target: { value: 'DELETE' } });
  fireEvent.click(screen.getByRole('button', { name: 'Delete my account' }));

  await waitFor(() => screen.getByText('Erased'));
  assert.match(screen.getByText('profile, login credentials, display name').textContent ?? '', /profile/);
  assert.ok(screen.getByText('Retained'));
  assert.match(
    screen.getByText(/financial records/).textContent ?? '',
    /financial records \(payments, refunds\)/,
  );
  // Confirmation form is gone — nothing left to resubmit.
  assert.equal(screen.queryByRole('button', { name: 'Delete my account' }), null);
});

test('a failed deletion request shows an error and does NOT clear the viewer\'s local session token', async () => {
  deletion.set(async () => { throw new Error('Could not process your deletion request'); });
  const clearedBefore = clearedCount;
  const { default: ViewerDeleteAccountPage } = await import(`./page?t=${Math.random()}`);
  render(<ViewerDeleteAccountPage />);

  fireEvent.change(screen.getByLabelText('Type DELETE to confirm'), { target: { value: 'DELETE' } });
  fireEvent.click(screen.getByRole('button', { name: 'Delete my account' }));

  await waitFor(() => screen.getByRole('alert'));
  assert.equal(screen.getByRole('alert').textContent, 'Could not process your deletion request');
  // clearViewerAccessToken must only run after a SUCCESSFUL request — a
  // failed request must not silently sign the viewer out of their own
  // session while their account still exists.
  assert.equal(clearedCount, clearedBefore);
});
