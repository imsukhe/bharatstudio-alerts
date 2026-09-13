import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mockViewerApi } from '../../test-support/mock-viewer-api';
import { controllable } from '../../test-support/controllable';
import type * as viewerApi from '../lib/viewer-api';

/*
 * Proves the search page:
 *  - never renders anything but exactly what the last search call returned
 *    (no client-side merge/cache), so a viewer who goes private between
 *    two searches cannot have a stale public row survive on screen;
 *  - never prints financial data;
 *  - states the public/no-account nature of the results plainly.
 * The structural guarantee that a private profile can never BE one of
 * those rows lives server-side (searchPublicProfiles's own where clause —
 * see apps/api/src/routes/viewer.ts's comment on
 * GET /v1/public/viewer-profiles); this file proves the page adds no way
 * to defeat that once the row is on the wire.
 */

const search = controllable<Parameters<typeof viewerApi.searchPublicViewerProfiles>, Awaited<ReturnType<typeof viewerApi.searchPublicViewerProfiles>>>(
  async () => [],
);
mockViewerApi({ searchPublicViewerProfiles: search.fn });

async function renderFreshPage() {
  const { default: ViewerSearchPage } = await import(`./page?t=${Math.random()}`);
  render(<ViewerSearchPage />);
}

test('search page states the public, opted-in nature of results and never mentions financial history', async () => {
  await renderFreshPage();
  assert.ok(screen.getByText(/opted in to a public profile/i));
  assert.equal(screen.queryByText(/₹|payment amount|lifetime support/i), null);
});

test('a profile visible in one search never survives a later search that omits it (no client-side merge or cache)', async () => {
  search.set(async () => [{ displayName: 'Ravi', profileSlug: 'ravi' }]);
  await renderFreshPage();
  fireEvent.change(screen.getByLabelText('Search public profiles'), { target: { value: 'ravi' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  await waitFor(() => screen.getByText('Ravi'));

  // Simulate the viewer having gone private in between (or the profile no
  // longer matching): the very next search call returns nothing.
  search.set(async () => []);
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  await waitFor(() => screen.getByText('No public profiles found.'));
  assert.equal(screen.queryByText('Ravi'), null);
});

test('results render only the display name and profile link the API returned, nothing else', async () => {
  search.set(async () => [{ displayName: null, profileSlug: 'anon-slug' }]);
  await renderFreshPage();
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  await waitFor(() => screen.getByText('anon-slug'));
  assert.ok(screen.getByRole('link', { name: 'anon-slug' }).getAttribute('href')?.includes('/viewer/profiles/anon-slug'));
});
