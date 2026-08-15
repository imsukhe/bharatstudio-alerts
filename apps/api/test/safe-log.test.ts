import test from 'node:test';
import assert from 'node:assert/strict';
import { logSafeError, safeErrorFields } from '../src/observability/safe-log.js';

test('safe error fields never expose messages or stacks', () => {
  const error = new Error('donor secret and SQL text must not be logged');
  error.stack = 'Error: donor secret\n at internal/provider.ts:1:1';
  assert.deepEqual(safeErrorFields(error), { error_type: 'Error' });
  assert.equal(JSON.stringify(safeErrorFields(error)).includes('donor secret'), false);
  assert.equal(JSON.stringify(safeErrorFields(error)).includes('provider.ts'), false);
});

test('non-Error values are reduced to fixed categories', () => {
  assert.deepEqual(safeErrorFields('user-controlled error'), { error_type: 'string_error' });
  assert.deepEqual(safeErrorFields({ message: 'sensitive' }), { error_type: 'unknown' });
});

test('safe logger keeps only approved operational context labels', () => {
  let captured: Record<string, unknown> | undefined;
  const request = {
    id: 'request-1',
    log: { error(fields: Record<string, unknown>) { captured = fields; } },
  } as never;
  logSafeError(request, 'maintenance_job_failed', new Error('secret'), {
    job: 'overlay-sessions',
    donor: 'private-donor-name',
  });
  assert.deepEqual(captured, {
    event: 'maintenance_job_failed',
    trace_id: 'request-1',
    error_type: 'Error',
    job: 'overlay-sessions',
  });
});
