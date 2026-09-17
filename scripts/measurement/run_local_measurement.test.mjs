import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, unlink, readdir } from 'node:fs/promises';
const run = promisify(execFile);
import { mkdtemp, symlink, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// These tests need the runner to find NO docker, so it reports the blocked
// path. The original way of arranging that was a hardcoded
// PATH=/opt/homebrew/bin:/usr/bin:/bin -- which removes docker only on a Mac.
// On an ubuntu CI runner /usr/bin/docker exists, so the runner found docker,
// took the live path and returned 1 instead of 2. The assertion was sound; the
// premise was platform-specific, and it went unnoticed because the job always
// failed at an earlier step and measurement:test had never once run in CI.
//
// Instead: a private directory holding a symlink to this very node binary and
// nothing else. The runner still resolves `node` for the manifest validator
// (run_local_measurement.py:110); `shutil.which("docker")` finds nothing, on
// every platform.
let dockerFreePath;
async function dockerFreeEnv() {
  if (!dockerFreePath) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'bsa-docker-free-'));
    await symlink(process.execPath, path.join(dir, 'node'));
    // execFile resolves `python3` from the CHILD's PATH, and the runner shells
    // out to `node` for the manifest validator. Both must be reachable; docker
    // must not be. Resolve python3 from the real PATH once and link it in.
    const python = await firstOnPath('python3');
    assert.ok(python, 'python3 must be resolvable to run the measurement runner');
    await symlink(python, path.join(dir, 'python3'));
    dockerFreePath = dir;
  }
  return { ...process.env, PATH: dockerFreePath };
}

async function firstOnPath(binary) {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, binary);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // not here; keep looking
    }
  }
  return undefined;
}


const runner = decodeURIComponent(new URL('./run_local_measurement.py', import.meta.url).pathname);
test('runner reports Docker-unavailable as blocked exit 2 with truthful artifact', async () => {
  const artifact = `/tmp/bsa-measurement-test-${process.pid}.json`;
  const env = await dockerFreeEnv();
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
  const result = await run('python3', [runner, '--full', '--artifact', artifact], { env: await dockerFreeEnv() }).catch((e) => e);
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
    const result = await run('python3', [runner, '--artifact', target], { env: await dockerFreeEnv() }).catch((e) => e);
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
