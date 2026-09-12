import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { mockViewerApi } from '../../test-support/mock-viewer-api';
import { controllable } from '../../test-support/controllable';
import type * as viewerApi from '../lib/viewer-api';

const signup = controllable<Parameters<typeof viewerApi.viewerSignup>, Awaited<ReturnType<typeof viewerApi.viewerSignup>>>(
  async () => ({ accessToken: 'tok', expiresAt: '2026-01-01T00:00:00.000Z' }),
);

mockViewerApi({ viewerSignup: signup.fn });

test('this page renders the viewer\'s own nav, never the creator AppShell/TopNav chrome', async () => {
  const { default: ViewerSignupPage } = await import(`./page?t=${Math.random()}`);
  render(<ViewerSignupPage />);
  // Creator chrome (AppShell/TopNav) carries a "navigation" landmark and
  // links to /companion, /payments — a viewer page must show none of it.
  assert.equal(screen.queryByRole('navigation'), null);
  assert.equal(screen.queryByText('Companion'), null);
  assert.equal(screen.queryByRole('link', { name: 'Payments' }), null);
});

test('email and password are required, and password enforces the min length in the DOM, not just server-side', async () => {
  const { default: ViewerSignupPage } = await import(`./page?t=${Math.random()}`);
  render(<ViewerSignupPage />);
  const email = screen.getByRole('textbox', { name: /Email/ }) as HTMLInputElement;
  const password = document.querySelector('input[type="password"]') as HTMLInputElement;
  assert.equal(email.required, true);
  assert.equal(password.required, true);
  assert.equal(password.minLength, 8);
});

test('a failed signup (e.g. email already registered) renders the error via StatusMessage and does not navigate away', async () => {
  signup.set(async () => { throw new Error('An account already exists for that email'); });
  const { default: ViewerSignupPage } = await import(`./page?t=${Math.random()}`);
  render(<ViewerSignupPage />);

  fireEvent.change(screen.getByRole('textbox', { name: /Email/ }), { target: { value: 'someone@example.com' } });
  fireEvent.change(document.querySelector('input[type="password"]') as HTMLInputElement, { target: { value: 'longenough1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

  await waitFor(() => screen.getByRole('alert'));
  assert.equal(screen.getByRole('alert').textContent, 'An account already exists for that email');
});
