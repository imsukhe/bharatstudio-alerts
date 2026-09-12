/*
 * Shared helper for component tests that render a page importing
 * `../lib/api` (or `../../lib/api`, etc.). Real `getCurrentUser`/`apiFetch`
 * calls hit `fetch` against a real API origin, which does not exist in the
 * test process — every page test instead swaps the whole module for the
 * real exports plus per-test overrides, via node:test's experimental
 * `mock.module`.
 *
 * Usage (see README.md in this directory):
 *   import { mockApi } from '../test-support/mock-api';
 *   mockApi({ getCurrentUser: async () => (...) });
 *
 * Call it BEFORE the dynamic `await import('./page')` of the page under
 * test — `mock.module` only affects imports that happen after it runs.
 * `mock.restoreAll()` is registered once per process; each test that wants
 * a clean slate should call `mockApi` again with its own full override set
 * (mock.module is idempotent per specifier — set order does not stack).
 */
import { mock } from 'node:test';
import * as realApi from '../lib/api';

const apiModulePath = new URL('../lib/api.ts', import.meta.url).pathname;

// node:test's mock.module() throws ERR_INVALID_STATE if the same specifier
// is already mocked — a second `mockApi(...)` call in the same test file
// (e.g. one per `test(...)`, to vary the fixture) needs the previous mock
// restored first, not stacked.
let active: ReturnType<typeof mock.module> | null = null;

export function mockApi(overrides: Partial<typeof realApi>): void {
  active?.restore();
  active = mock.module(apiModulePath, {
    namedExports: { ...realApi, ...overrides },
  });
}
