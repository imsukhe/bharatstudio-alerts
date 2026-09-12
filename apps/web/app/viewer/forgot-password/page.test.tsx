import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { mockViewerApi } from '../../test-support/mock-viewer-api';
import { controllable } from '../../test-support/controllable';
import type * as viewerApi from '../lib/viewer-api';

const requestReset = controllable<Parameters<typeof viewerApi.requestViewerPasswordReset>, Awaited<ReturnType<typeof viewerApi.requestViewerPasswordReset>>>(
  async () => ({ message: 'If that email is registered, a reset link has been sent' }),
);

mockViewerApi({ requestViewerPasswordReset: requestReset.fn });

test('submitting hides the form and shows the same confirmation whether or not the email exists', async () => {
  requestReset.set(async () => ({ message: 'If that email is registered, a reset link has been sent' }));
  const { default: ViewerForgotPasswordPage } = await import(`./page?t=${Math.random()}`);
  render(<ViewerForgotPasswordPage />);

  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'someone@example.com' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));

  await waitFor(() => screen.getByText('If that email is registered, a reset link has been sent'));
  assert.equal(screen.getByRole('status').className, 'inline-message');
  // The form (and its submit button) is gone once a request has been sent —
  // there's nothing left to resubmit or re-validate.
  assert.equal(screen.queryByRole('button', { name: 'Send reset link' }), null);
});

test('an unavailable API still shows the same non-revealing confirmation, never an error', async () => {
  requestReset.set(async () => { throw new Error('network down'); });
  const { default: ViewerForgotPasswordPage } = await import(`./page?t=${Math.random()}`);
  render(<ViewerForgotPasswordPage />);

  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'someone@example.com' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));

  await waitFor(() => screen.getByText('If that email is registered, a reset link has been sent'));
  assert.equal(screen.queryByRole('alert'), null);
});
