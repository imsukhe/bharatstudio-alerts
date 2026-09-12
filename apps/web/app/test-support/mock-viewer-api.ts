/*
 * Same purpose as mock-api.ts, for the separate viewer auth surface
 * (app/viewer/lib/viewer-api.ts). Kept as its own file/module specifier —
 * mirroring the app's own creator/viewer separation — rather than one
 * mock covering both surfaces.
 */
import { mock } from 'node:test';
import * as realViewerApi from '../viewer/lib/viewer-api';

const viewerApiModulePath = new URL('../viewer/lib/viewer-api.ts', import.meta.url).pathname;

let active: ReturnType<typeof mock.module> | null = null;

export function mockViewerApi(overrides: Partial<typeof realViewerApi>): void {
  active?.restore();
  active = mock.module(viewerApiModulePath, {
    namedExports: { ...realViewerApi, ...overrides },
  });
}
