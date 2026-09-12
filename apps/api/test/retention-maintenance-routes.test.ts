import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import type { RuntimeConfig } from '../src/config.js';
import type { MaintenanceStore } from '../src/domain/maintenance.js';
import { retentionJobs, retentionWindows } from '../src/domain/retention-policy.js';

const config: RuntimeConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 4100,
  appOrigin: 'http://localhost:3100',
  paymentEnvironment: 'live',
};

for (const job of retentionJobs) {
  test(`maintenance route accepts the ${job} retention job after identity verification`, async () => {
    let received: unknown;
    const store: MaintenanceStore = {
      async execute(request) {
        received = request;
        return { schemaVersion: 'v1', job: request.job, status: 'accepted', runId: '00000000-0000-4000-8000-000000000199' };
      },
    };
    const app = await buildApp(config, { serviceIdentity: { verify: async () => true }, maintenance: store });
    const response = await app.inject({
      method: 'POST',
      url: `/internal/maintenance/${job}`,
      headers: { authorization: 'Bearer synthetic-internal-token' },
      payload: { idempotencyKey: 'synthetic-retention-job-001' },
    });
    assert.equal(response.statusCode, 202);
    assert.deepEqual(received, { job, idempotencyKey: 'synthetic-retention-job-001', window: undefined });
    await app.close();
  });
}

test('retention job still requires service identity, same as every other maintenance job', async () => {
  const identity = { verify: async (authorization?: string) => authorization === 'Bearer synthetic-internal-token' };
  const app = await buildApp(config, { serviceIdentity: identity });
  const unauthorized = await app.inject({
    method: 'POST',
    url: '/internal/maintenance/retention-viewer-reset-tokens',
    payload: { idempotencyKey: 'synthetic-retention-job-002' },
  });
  assert.equal(unauthorized.statusCode, 401);
  await app.close();
});

test('retention windows are decided per table, not copy-pasted', () => {
  assert.equal(retentionWindows['retention-companion-pairings'].windowDays, 7);
  assert.equal(retentionWindows['retention-youtube-oauth-states'].windowDays, 0);
  assert.equal(retentionWindows['retention-viewer-reset-tokens'].windowDays, 0);
  for (const job of retentionJobs) {
    assert.ok(retentionWindows[job].reason.length > 0, `${job} must state a reason for its window`);
  }
});
