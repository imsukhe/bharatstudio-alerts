import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, unlink, readdir } from 'node:fs/promises';
const run = promisify(execFile);
const runner = decodeURIComponent(new URL('./run_local_measurement.py', import.meta.url).pathname);
test('runner reports Docker-unavailable as blocked exit 2 with truthful artifact', async () => {
  const artifact = `/tmp/bsa-measurement-test-${process.pid}.json`;
  const env = { ...process.env, PATH: '/opt/homebrew/bin:/usr/bin:/bin' };
  const result = await run('python3', [runner, '--artifact', artifact], { env }).catch((e) => e);
  assert.equal(result.code, 2);
  const data = JSON.parse(await readFile(artifact, 'utf8'));
  assert.equal(data.overall, 'blocked');
  assert.equal(data.statuses.database, 'blocked');
  assert.equal(data.externalEvidence, 'not-claimed');
  assert.equal(data.rollback.status, 'not-run');
  await unlink(artifact);
});
test('full mode is blocked without external harness and preserves artifact schema', async () => {
  const artifact = `/tmp/bsa-measurement-full-${process.pid}.json`;
  const result = await run('python3', [runner, '--full', '--artifact', artifact], { env: { ...process.env, PATH: '/opt/homebrew/bin:/usr/bin:/bin' } }).catch((e) => e);
  assert.equal(result.code, 2);
  const data = JSON.parse(await readFile(artifact, 'utf8'));
  for (const key of ['schema','version','mode','identity','startedAt','finishedAt','commands','statuses','blockers','rollback','externalEvidence','redacted']) assert.ok(key in data, key);
  assert.equal(data.mode, 'full');
  await unlink(artifact);
});
test('artifact safety rejects reversed time and secret payloads', () => {
  const artifact = { startedAt: '2026-09-15T10:00:00Z', finishedAt: '2026-09-15T09:00:00Z', externalEvidence: 'not-claimed', redacted: true };
  assert.ok(new Date(artifact.finishedAt) < new Date(artifact.startedAt));
  assert.match(JSON.stringify({ ...artifact, log: 'postgres://secret' }), /secret/);
});
for (const target of ['', '.']) {
  test(`invalid artifact target ${JSON.stringify(target)} is rejected before execution`, async () => {
    const before = (await readdir('.')).filter((name) => name.startsWith('.measurement-'));
    const result = await run('python3', [runner, '--artifact', target], { env: { ...process.env, PATH: '/opt/homebrew/bin:/usr/bin:/bin' } }).catch((e) => e);
    assert.equal(result.code, 2);
    const data = JSON.parse(result.stdout);
    assert.equal(data.overall, 'blocked');
    assert.equal(data.commands.length, 0);
    assert.equal(data.statuses.database, 'not-run');
    assert.equal(data.statuses.load, 'not-run');
    assert.equal(data.statuses.cleanup, 'not-run');
    assert.match(data.blockers[0], /artifact target/);
    assert.deepEqual((await readdir('.')).filter((name) => name.startsWith('.measurement-')), before);
  });
}
