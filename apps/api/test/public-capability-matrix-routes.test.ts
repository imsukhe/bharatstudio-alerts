import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import type { RuntimeConfig } from '../src/config.js';
import type { PublicCapabilityMatrixEntry, PublicCapabilityMatrixRepository } from '../src/domain/public-capability-matrix.js';

/*
 * CTL-10 (migration 0160). Route-layer proof only -- the SQL layer's own
 * proof (exact returned column set, non-marketing_visible/killed rows
 * absent, published-snapshot freshness) lives in packages/db/tests/
 * ctl_public_capability_matrix.sql. This file proves: no auth is
 * required at all (the one capability surface with no token), the
 * response carries exactly the declared fields, and an unwired store
 * degrades to a safe 503, never a crash.
 */

const config: RuntimeConfig = { nodeEnv: 'test', host: '127.0.0.1', port: 4105, appOrigin: 'http://localhost:3105', paymentEnvironment: 'test' };

const sampleEntries: PublicCapabilityMatrixEntry[] = [
  {
    capabilityId: 'ctl_pubmatrix_route_probe',
    marketingLabel: 'Probe Widget',
    marketingBlurb: 'A route-test probe.',
    minTier: 'pro',
    isMarketingSection: false,
    snapshotVersion: 3,
    publishedAt: '2026-09-17T09:00:00.000Z',
  },
  {
    capabilityId: 'ctl_pubmatrix_route_section',
    marketingLabel: 'Pricing Hero',
    marketingBlurb: 'The pricing page hero section.',
    minTier: null,
    isMarketingSection: true,
    snapshotVersion: 3,
    publishedAt: '2026-09-17T09:00:00.000Z',
  },
];

function fakeStore(overrides: Partial<PublicCapabilityMatrixRepository> = {}): PublicCapabilityMatrixRepository {
  return {
    async getMatrix() { return sampleEntries; },
    ...overrides,
  };
}

test('public capability matrix: no auth required -- 200 with no session, no bearer token, no cookie', async () => {
  const app = await buildApp(config, { publicCapabilityMatrix: fakeStore() });
  const response = await app.inject({ method: 'GET', url: '/v1/public/capability-matrix' });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.schemaVersion, 'v1');
  assert.equal(body.entries.length, 2);
  await app.close();
});

test('public capability matrix: response carries exactly the declared fields, nothing else', async () => {
  const app = await buildApp(config, { publicCapabilityMatrix: fakeStore() });
  const response = await app.inject({ method: 'GET', url: '/v1/public/capability-matrix' });
  const entry = response.json().entries[0];
  assert.deepEqual(Object.keys(entry).sort(), [
    'capabilityId', 'isMarketingSection', 'marketingBlurb', 'marketingLabel', 'minTier', 'publishedAt', 'snapshotVersion',
  ].sort());
  assert.equal(entry.capabilityId, 'ctl_pubmatrix_route_probe');
  assert.equal(entry.marketingLabel, 'Probe Widget');
  assert.equal(entry.minTier, 'pro');
  assert.equal(entry.isMarketingSection, false);
  assert.equal(entry.snapshotVersion, 3);
  await app.close();
});

test('public capability matrix: an empty published matrix returns 200 with an empty array, never an error', async () => {
  const app = await buildApp(config, { publicCapabilityMatrix: fakeStore({ async getMatrix() { return []; } }) });
  const response = await app.inject({ method: 'GET', url: '/v1/public/capability-matrix' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().entries, []);
  await app.close();
});

test('public capability matrix: fails closed (503) with no configured store, never a crash', async () => {
  const app = await buildApp(config, {});
  const response = await app.inject({ method: 'GET', url: '/v1/public/capability-matrix' });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().errorCode, 'public_capability_matrix_unavailable');
  assert.equal(response.json().retryable, true);
  await app.close();
});
