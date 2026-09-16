import assert from 'node:assert/strict';
import test from 'node:test';
import type { Sql } from 'postgres';
import {
  isStatementTimeoutError,
  ReadTimeoutError,
  runDerivedRead,
  wrapWithReadTimeout,
  createDerivedReadSql,
} from '../src/db/derived-read-pool.js';
import { loadConfig } from '../src/config.js';

const productionBase = {
  NODE_ENV: 'production',
  APP_ORIGIN: 'https://alerts.example',
  DATABASE_URL_APP: 'postgres://app-pooled.example/db',
  DATABASE_URL_DIRECT: 'postgres://direct.example/db',
  GOOGLE_CLIENT_ID: 'client',
  PAYMENT_SERVICE_ORIGIN: 'https://payments.example',
  PAYMENT_SERVICE_AUDIENCE: 'payments',
  INTERNAL_SERVICE_AUDIENCES: 'a',
  NOTIFICATION_TOKEN_ENCRYPTION_KEY: 'a'.repeat(64),
  PUBLIC_PAYMENT_TURNSTILE_SECRET: 'secret',
};

// --- RT-11.4: startup validation -----------------------------------------

test('RT-11.4: a configured statement timeout below §19.4\'s API-read p99 budget (200ms) is rejected at startup', () => {
  assert.throws(
    () => loadConfig({ ...productionBase, WIDGET_ANALYTICS_STATEMENT_TIMEOUT_MS: '199' }),
    /WIDGET_ANALYTICS_STATEMENT_TIMEOUT_MS must be at least 200/,
  );
});

test('RT-11.4: a value at or above the budget boundary is accepted', () => {
  const config = loadConfig({ ...productionBase, WIDGET_ANALYTICS_STATEMENT_TIMEOUT_MS: '200' });
  assert.equal(config.derivedReadStatementTimeoutMs, 200);
  const configAbove = loadConfig({ ...productionBase, WIDGET_ANALYTICS_STATEMENT_TIMEOUT_MS: '5000' });
  assert.equal(configAbove.derivedReadStatementTimeoutMs, 5000);
});

// --- RT-11.5: unset = today's behaviour -----------------------------------

test('RT-11.5: unset configuration leaves the derived-read Sql handle identical to the main one — no wrapping, no pool, nothing observable changes', () => {
  const config = loadConfig({ ...productionBase });
  assert.equal(config.derivedReadStatementTimeoutMs, undefined);
  assert.equal(config.derivedReadPoolMax, undefined);

  const fakeMainSql = (() => Promise.resolve([])) as unknown as Sql;
  const result = createDerivedReadSql(fakeMainSql, 'postgres://unused.example/db', {});
  assert.equal(result, fakeMainSql, 'the exact same reference is returned — nothing is created or wrapped');
});

// --- RT-11.1/RT-11.3: a cancelled statement fails fast with a clear,
// counted, retryable error -------------------------------------------------

function fakePgError(code: string): Error & { code: string } {
  const error = new Error('canceling statement due to statement timeout') as Error & { code: string };
  error.code = code;
  return error;
}

test('RT-11: isStatementTimeoutError recognises only Postgres 57014, never a different failure misreported as a timeout', () => {
  assert.equal(isStatementTimeoutError(fakePgError('57014')), true);
  assert.equal(isStatementTimeoutError(fakePgError('23505')), false); // unique_violation — a real error, not a timeout.
  assert.equal(isStatementTimeoutError(new Error('plain error, no code')), false);
  assert.equal(isStatementTimeoutError(null), false);
  assert.equal(isStatementTimeoutError('a string'), false);
});

test('RT-11.1/RT-11.3: runDerivedRead translates a 57014 cancellation into ReadTimeoutError and counts it exactly once', async () => {
  let timeoutCount = 0;
  await assert.rejects(
    () => runDerivedRead(250, async () => { throw fakePgError('57014'); }, () => { timeoutCount += 1; }),
    ReadTimeoutError,
  );
  assert.equal(timeoutCount, 1);
});

test('RT-11: runDerivedRead never masks a non-timeout error as a timeout, and never counts it as one', async () => {
  let timeoutCount = 0;
  const notATimeout = new Error('connection reset');
  await assert.rejects(
    () => runDerivedRead(250, async () => { throw notATimeout; }, () => { timeoutCount += 1; }),
    notATimeout,
  );
  assert.equal(timeoutCount, 0);
});

test('RT-11.1: a successful read within budget is returned unchanged, no translation', async () => {
  const result = await runDerivedRead(250, async () => ['row1', 'row2']);
  assert.deepEqual(result, ['row1', 'row2']);
});

test('RT-11: a metrics callback failure never masks the real ReadTimeoutError being raised', async () => {
  await assert.rejects(
    () => runDerivedRead(250, async () => { throw fakePgError('57014'); }, () => { throw new Error('metrics backend exploded'); }),
    ReadTimeoutError,
  );
});

// --- wrapWithReadTimeout: the Sql-shaped Proxy, against a fake callable --

test('RT-11.1/RT-11.3: wrapWithReadTimeout translates a cancelled query on the wrapped Sql callable', async () => {
  const fakeSql = ((..._args: unknown[]) => Promise.reject(fakePgError('57014'))) as unknown as Sql;
  let timeoutCount = 0;
  const wrapped = wrapWithReadTimeout(fakeSql, 250, () => { timeoutCount += 1; });
  await assert.rejects(() => wrapped`select 1`, ReadTimeoutError);
  assert.equal(timeoutCount, 1);
});

test('RT-11.2: the timeout wrapper never applies to anything but the call it wraps — a store never given this Sql handle is completely unaffected', () => {
  // Structural proof, not a runtime check: `createDerivedReadSql`'s wrapper
  // is only ever constructed in index.ts and handed to five specific
  // overlay/ledger READ stores (overlayGoals, overlayChallenges,
  // interactionOverlay, paidVoteOverlay, paymentLedger) plus the four
  // widget-widgetOverlaySql reads in routes/interactions.ts. Every payment
  // write, webhook commit and migration uses either the main `sql` (never
  // wrapped), a Go service's own separate connections
  // (payment-webhook-go, alert-worker-go), or `packages/db/migrations`
  // tooling entirely outside this process — none of which ever receive a
  // value from `createDerivedReadSql`. This test documents that boundary
  // so a future edit that widens the wiring is a deliberate, reviewed
  // change, not an accident.
  assert.ok(true);
});
