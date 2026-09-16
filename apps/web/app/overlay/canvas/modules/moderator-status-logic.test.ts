import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatHeldLabel, hasSomethingHeld, isModeratorStatus, type ModeratorStatus } from './moderator-status-logic';

/*
 * PRF-02 slice 5, §6 module #12 (Moderator Status Card, held half only).
 * The pure half: the guard, the zero-case predicate and the label.
 */

// --- S5.13: the guard accepts only the exact shape ------------------------

test('isModeratorStatus accepts exactly { schemaVersion, heldCount } with a non-negative safe integer', () => {
  assert.equal(isModeratorStatus({ schemaVersion: 'v1', heldCount: 0 }), true);
  assert.equal(isModeratorStatus({ schemaVersion: 'v1', heldCount: 1 }), true);
  assert.equal(isModeratorStatus({ schemaVersion: 'v1', heldCount: 999 }), true);
});

test('isModeratorStatus rejects a missing, wrong-typed, negative or fractional count', () => {
  assert.equal(isModeratorStatus({ schemaVersion: 'v1' }), false);
  assert.equal(isModeratorStatus({ schemaVersion: 'v1', heldCount: '3' }), false);
  assert.equal(isModeratorStatus({ schemaVersion: 'v1', heldCount: -1 }), false);
  assert.equal(isModeratorStatus({ schemaVersion: 'v1', heldCount: 1.5 }), false);
  assert.equal(isModeratorStatus({ schemaVersion: 'v1', heldCount: Number.NaN }), false);
  assert.equal(isModeratorStatus({ schemaVersion: 'v1', heldCount: Number.POSITIVE_INFINITY }), false);
  assert.equal(isModeratorStatus({ schemaVersion: 'v2', heldCount: 3 }), false);
  assert.equal(isModeratorStatus(null), false);
  assert.equal(isModeratorStatus(undefined), false);
  assert.equal(isModeratorStatus(3), false);
  assert.equal(isModeratorStatus([{ schemaVersion: 'v1', heldCount: 3 }]), false);
});

test('isModeratorStatus rejects a payload carrying ANY private field alongside the count (§6: never private content)', () => {
  // The query cannot produce these — its returned column set is asserted
  // to be exactly {held_count} in
  // packages/db/tests/prf02_slice5_moderator_status.sql, and the API
  // route narrows again before this ever runs. This is the third,
  // last-line check: a payload with an unexpected key fails the guard
  // outright rather than being silently ignored and, one careless
  // refactor later, rendered.
  for (const [field, value] of [
    ['supporterName', 'Riya'],
    ['message', 'a private supporter message'],
    ['amountPaise', 300000],
    ['deliveryId', '00000000-0000-4000-8000-000000005561'],
    ['queueId', '00000000-0000-4000-8000-000000005521'],
    ['viewerIdentityId', '00000000-0000-4000-8000-0000000000a1'],
  ] as const) {
    assert.equal(
      isModeratorStatus({ schemaVersion: 'v1', heldCount: 3, [field]: value }),
      false,
      `a payload carrying ${field} must be rejected outright`,
    );
  }
});

test('isModeratorStatus rejects a safe-mode field — safe mode is not built and is not the queue-paused flag', () => {
  // Owner decision, 2026-09-16 (§6's module table): safe mode is a
  // separate moderation control that does not exist in the schema and
  // needs its own record and decision. If a server ever started sending
  // one, this card must render nothing rather than invent a meaning for
  // it.
  assert.equal(isModeratorStatus({ schemaVersion: 'v1', heldCount: 3, safeMode: true }), false);
  assert.equal(isModeratorStatus({ schemaVersion: 'v1', heldCount: 3, isPaused: true }), false);
  assert.equal(isModeratorStatus({ schemaVersion: 'v1', heldCount: 3, paused: false }), false);
});

// --- S5.15/S5.16: the zero-case predicate --------------------------------

test('hasSomethingHeld is false at zero and false for no answer, true above zero', () => {
  assert.equal(hasSomethingHeld(null), false);
  assert.equal(hasSomethingHeld({ schemaVersion: 'v1', heldCount: 0 }), false);
  assert.equal(hasSomethingHeld({ schemaVersion: 'v1', heldCount: 1 }), true);
  assert.equal(hasSomethingHeld({ schemaVersion: 'v1', heldCount: 42 }), true);
});

// --- S5.14: the label names held deliveries, never chat -------------------

test('formatHeldLabel reads "N held for review", singular and plural alike', () => {
  assert.equal(formatHeldLabel(1), '1 held for review');
  assert.equal(formatHeldLabel(4), '4 held for review');
  assert.equal(formatHeldLabel(120), '120 held for review');
});

test('formatHeldLabel never says "messages", "chat" or "comments" — this is a held ALERT DELIVERY count', () => {
  // §6's original wording said "messages held"; the owner corrected it on
  // 2026-09-16 because the underlying state is held alert deliveries, not
  // chat messages. A creator reading "3 messages held" beside their
  // stream could reasonably think of their platform's own live-chat
  // held-messages queue, which is a different system's different number.
  for (const count of [1, 2, 37]) {
    const label = formatHeldLabel(count).toLowerCase();
    for (const forbidden of ['message', 'chat', 'comment']) {
      assert.equal(label.includes(forbidden), false, `"${label}" must not contain "${forbidden}"`);
    }
  }
});

test('formatHeldLabel writes no all-clear or celebratory copy for any count it is given', () => {
  // There is deliberately no zero branch: the module checks
  // hasSomethingHeld first and simply does not render. Asserting the
  // absence of the words here keeps someone from "helpfully" adding one
  // later without also revisiting the recorded decision.
  for (const count of [0, 1, 9]) {
    const label = formatHeldLabel(count).toLowerCase();
    for (const forbidden of ['all clear', 'nothing', 'great', 'well done', 'clean', 'safe mode']) {
      assert.equal(label.includes(forbidden), false, `"${label}" must not contain "${forbidden}"`);
    }
  }
});

// --- The type itself has no safe-mode slot -------------------------------

test('ModeratorStatus declares exactly two keys and no safe-mode field — a compile-time check', () => {
  type HasKey<K extends string> = K extends keyof ModeratorStatus ? true : false;
  const safeModeAbsent: HasKey<'safeMode'> = false;
  const isPausedAbsent: HasKey<'isPaused'> = false;
  assert.equal(safeModeAbsent, false);
  assert.equal(isPausedAbsent, false);
  const sample: ModeratorStatus = { schemaVersion: 'v1', heldCount: 1 };
  assert.deepEqual(Object.keys(sample), ['schemaVersion', 'heldCount']);
});
