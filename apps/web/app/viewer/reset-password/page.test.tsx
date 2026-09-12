import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { mockViewerApi } from '../../test-support/mock-viewer-api';
import { controllable } from '../../test-support/controllable';
import type * as viewerApi from '../lib/viewer-api';

// Regression target: the reset token must be read from the URL FRAGMENT
// (window.location.hash), never the query string. A token in a query
// string is logged by servers and leaked via the Referer header on any
// outbound link/asset from this page — a fragment is never sent to the
// server or included in Referer. See db/viewer-reset-store.ts's resetUrl.

const resetPassword = controllable<Parameters<typeof viewerApi.resetViewerPassword>, Awaited<ReturnType<typeof viewerApi.resetViewerPassword>>>(
  async () => ({ message: 'Your password has been reset' }),
);

mockViewerApi({ resetViewerPassword: resetPassword.fn });

function setLocation(hash: string, search = '') {
  window.history.pushState({}, '', `/viewer/reset-password${search}${hash}`);
}

test('the token is read from the URL fragment (#token=...) and submitted — a query-string token is ignored', async () => {
  setLocation('#token=fragment-secret-abc123', '?token=query-string-should-be-ignored');
  let submittedToken: string | undefined;
  resetPassword.set(async (token, newPassword) => { submittedToken = token; return { message: 'Your password has been reset' }; });

  const { default: ViewerResetPasswordPage } = await import(`./page?t=${Math.random()}`);
  render(<ViewerResetPasswordPage />);

  await waitFor(() => screen.getByRole('button', { name: 'Reset password' }));
  fireEvent.change(document.querySelector('input[type="password"]') as HTMLInputElement, { target: { value: 'newlongpass1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));

  await waitFor(() => screen.getByText('Your password has been reset'));
  assert.equal(submittedToken, 'fragment-secret-abc123', 'token submitted must come from the fragment, not the query string');
});

test('no fragment token present (only a query-string token) is treated as missing — the error state renders, not the form', async () => {
  setLocation('', '?token=query-string-only');
  const { default: ViewerResetPasswordPage } = await import(`./page?t=${Math.random()}`);
  render(<ViewerResetPasswordPage />);

  await waitFor(() => screen.getByRole('alert'));
  assert.equal(screen.getByRole('alert').textContent, 'This reset link is missing its token. Request a new one.');
  assert.equal(screen.queryByRole('button', { name: 'Reset password' }), null);
});

test('a failed reset (expired/invalid token) shows an error and does not show the signed-out-everywhere confirmation', async () => {
  setLocation('#token=expired-token');
  resetPassword.set(async () => { throw new Error('This reset link is invalid or has expired'); });

  const { default: ViewerResetPasswordPage } = await import(`./page?t=${Math.random()}`);
  render(<ViewerResetPasswordPage />);

  await waitFor(() => screen.getByRole('button', { name: 'Reset password' }));
  fireEvent.change(document.querySelector('input[type="password"]') as HTMLInputElement, { target: { value: 'newlongpass1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));

  await waitFor(() => screen.getByRole('alert'));
  assert.equal(screen.getByRole('alert').textContent, 'This reset link is invalid or has expired');
  assert.equal(screen.queryByText(/signed out for security/), null);
});
