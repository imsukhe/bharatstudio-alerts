import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mockViewerApi } from '../../test-support/mock-viewer-api';
import { controllable } from '../../test-support/controllable';
import type * as viewerApi from '../lib/viewer-api';

const saveVisibility = controllable<Parameters<typeof viewerApi.setViewerProfileVisibility>, Awaited<ReturnType<typeof viewerApi.setViewerProfileVisibility>>>(
  async () => ({ visibility: 'private', slug: null }),
);
mockViewerApi({ setViewerProfileVisibility: saveVisibility.fn });

async function renderFreshPage() {
  const { default: ViewerProfilePage } = await import(`./page?t=${Math.random()}`);
  render(<ViewerProfilePage />);
}

test('profile is private by default and never mentions financial history', async () => {
  await renderFreshPage();
  assert.ok(screen.getByLabelText('Keep my profile private').hasAttribute('checked'));
  assert.equal(screen.queryByText(/₹|payment amount|lifetime support/i), null);
});

test('publishing requires a slug and sends only visibility plus the slug', async () => {
  const seen: unknown[][] = [];
  saveVisibility.set(async (...args) => { seen.push(args); return { visibility: 'public', slug: 'ravi' }; });
  await renderFreshPage();
  fireEvent.click(screen.getByLabelText('Let people find my display name and profile link'));
  fireEvent.click(screen.getByRole('button', { name: 'Save visibility' }));
  assert.ok(screen.getByRole('alert').textContent?.includes('at least 3'));
  fireEvent.change(screen.getByLabelText('Public profile link'), { target: { value: 'Ravi' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save visibility' }));
  await waitFor(() => screen.getByRole('status'));
  assert.deepEqual(seen, [['public', 'ravi']]);
  assert.ok(screen.getByRole('status').textContent?.includes('public'));
});
