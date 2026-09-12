import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { mockViewerApi } from '../../test-support/mock-viewer-api';
import { controllable } from '../../test-support/controllable';
import type * as viewerApi from '../lib/viewer-api';

const login = controllable<Parameters<typeof viewerApi.viewerLogin>, Awaited<ReturnType<typeof viewerApi.viewerLogin>>>(
  async () => ({ accessToken: 'tok', expiresAt: '2026-01-01T00:00:00.000Z' }),
);

mockViewerApi({ viewerLogin: login.fn });

test('the email and password fields are required — the browser blocks an empty submit', async () => {
  const { default: ViewerLoginPage } = await import(`./page?t=${Math.random()}`);
  render(<ViewerLoginPage />);
  const email = screen.getByRole('textbox') as HTMLInputElement; // only text-type input is email
  const password = document.querySelector('input[type="password"]') as HTMLInputElement;
  assert.equal(email.required, true);
  assert.equal(password.required, true);
});

test('this page renders the viewer\'s own form, not the creator AppShell/TopNav chrome', async () => {
  const { default: ViewerLoginPage } = await import(`./page?t=${Math.random()}`);
  render(<ViewerLoginPage />);
  // Creator chrome (TopNav/AppShell) links to /dashboard, /companion, /payments
  // and carries a "Primary navigation" or "Dashboard navigation" landmark —
  // a viewer page must never render any of it.
  assert.equal(screen.queryByRole('navigation'), null);
  assert.equal(screen.queryByText('Companion'), null);
  assert.equal(screen.queryByRole('link', { name: 'Payments' }), null);
});

test('a failed sign-in renders the StatusMessage as an error, and the submit button re-enables', async () => {
  login.set(async () => { throw new Error('Invalid email or password'); });
  const { default: ViewerLoginPage } = await import(`./page?t=${Math.random()}`);
  render(<ViewerLoginPage />);

  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'viewer@example.com' } });
  fireEvent.change(document.querySelector('input[type="password"]') as HTMLInputElement, { target: { value: 'wrong-password' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

  await waitFor(() => screen.getByRole('alert'));
  assert.equal(screen.getByRole('alert').textContent, 'Invalid email or password');
  assert.equal((screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement).disabled, false);
});
