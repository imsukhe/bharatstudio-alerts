import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CHALLENGE_FAILURE_COPY } from '../../widgets/challenge/challenge-widget-logic';

/*
 * PRF-02 slice 4, §1(c): CHALLENGE_FAILURE_COPY is documented in two
 * places (apps/api/src/domain/challenge-store.ts and
 * challenge-widget-logic.ts) as "byte-identical", but until this test
 * nothing actually checked that at build/test time — only a comment in
 * each file asserted it. The Canvas module (challenge-board-module.ts)
 * imports the web-side copy directly rather than declaring a third one,
 * per this task's own instruction ("prefer importing the existing
 * constant over re-declaring it"), so there is no THIRD copy to compare
 * here. But the pre-existing TWO-copy situation this slice depends on
 * (the Canvas's honesty rests on the web-side constant staying in sync
 * with the API's) had no automated guard before this slice, so this test
 * adds one.
 *
 * apps/web and apps/api are separate packages with no shared import
 * boundary for internal modules — this test cannot `import` the API
 * file. It reads the API source file's own text directly and extracts
 * the string literal, mirroring the existing cross-package parity
 * pattern already used in this codebase
 * (accept-terms/terms-content.test.ts's "every active document hash also
 * appears in the DB seed migration" case, which reads
 * packages/db/migrations/0068... via fileURLToPath(new URL(..., import.meta.url))
 * rather than importing it).
 */

function readChallengeStoreFailureCopy(): string {
  const path = fileURLToPath(
    new URL('../../../../../api/src/domain/challenge-store.ts', import.meta.url),
  );
  const source = readFileSync(path, 'utf8');
  const match = source.match(/export const CHALLENGE_FAILURE_COPY =\s*\n?\s*'((?:[^'\\]|\\.)*)';/);
  assert.ok(match, 'could not locate CHALLENGE_FAILURE_COPY in apps/api/src/domain/challenge-store.ts — has its declaration shape changed?');
  // The source is a single-quoted TS string literal with no escapes in
  // practice (verified below by exact-match against the web copy); no
  // unescaping beyond that is attempted, so a change to escaping would
  // fail this test loudly rather than silently pass a wrong comparison.
  return match![1]!;
}

test('CHALLENGE_FAILURE_COPY is byte-identical between the API (challenge-store.ts) and the web widget (challenge-widget-logic.ts) — the two copies this whole product\'s honesty rests on cannot silently diverge', () => {
  const apiCopy = readChallengeStoreFailureCopy();
  assert.equal(apiCopy, CHALLENGE_FAILURE_COPY);
});

test('the protected copy names no false refund promise — it only ever DENIES holding funds/issuing a refund, never asserts one will happen', () => {
  assert.match(CHALLENGE_FAILURE_COPY, /cannot issue a refund/);
  assert.match(CHALLENGE_FAILURE_COPY, /holds no funds/);
  assert.doesNotMatch(CHALLENGE_FAILURE_COPY, /will (be )?refund/i);
  assert.doesNotMatch(CHALLENGE_FAILURE_COPY, /guarantee/i);
});
