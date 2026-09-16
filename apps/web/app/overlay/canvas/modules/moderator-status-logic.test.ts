import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatHeldLabel,
  formatModeratorStatusLabel,
  formatSafeModeLabel,
  hasSomethingHeld,
  hasSomethingToShow,
  isModeratorStatus,
  type ModeratorStatus,
} from './moderator-status-logic';

/*
 * PRF-02, §6 module #12 (Moderator Status Card). The pure half: the
 * guard, the visibility predicates and the label.
 *
 * Slice 5 built the held half. Safe mode (migration 0138) completes it,
 * and every slice-5 assertion below was EXTENDED rather than deleted —
 * in particular the private-field refusals and the "no all-clear copy"
 * rule, both of which still hold exactly as they did.
 */

// --- S5.13: the guard accepts only the exact shape ------------------------

test('isModeratorStatus accepts exactly { schemaVersion, heldCount, safeMode }', () => {
  assert.equal(isModeratorStatus({ schemaVersion: 'v1', heldCount: 0, safeMode: false }), true);
  assert.equal(isModeratorStatus({ schemaVersion: 'v1', heldCount: 0, safeMode: true }), true);
  assert.equal(isModeratorStatus({ schemaVersion: 'v1', heldCount: 1, safeMode: false }), true);
  assert.equal(isModeratorStatus({ schemaVersion: 'v1', heldCount: 999, safeMode: true }), true);
});

test('isModeratorStatus rejects a missing, wrong-typed, negative or fractional count', () => {
  assert.equal(isModeratorStatus({ schemaVersion: 'v1', safeMode: false }), false);
  assert.equal(isModeratorStatus({ schemaVersion: 'v1', heldCount: '3', safeMode: false }), false);
  assert.equal(isModeratorStatus({ schemaVersion: 'v1', heldCount: -1, safeMode: false }), false);
  assert.equal(isModeratorStatus({ schemaVersion: 'v1', heldCount: 1.5, safeMode: false }), false);
  assert.equal(isModeratorStatus({ schemaVersion: 'v1', heldCount: Number.NaN, safeMode: false }), false);
  assert.equal(isModeratorStatus({ schemaVersion: 'v1', heldCount: Number.POSITIVE_INFINITY, safeMode: false }), false);
  assert.equal(isModeratorStatus({ schemaVersion: 'v2', heldCount: 3, safeMode: false }), false);
  assert.equal(isModeratorStatus(null), false);
  assert.equal(isModeratorStatus(undefined), false);
  assert.equal(isModeratorStatus(3), false);
  assert.equal(isModeratorStatus([{ schemaVersion: 'v1', heldCount: 3, safeMode: false }]), false);
});

test('isModeratorStatus rejects a missing or non-boolean safeMode, and never coerces one', () => {
  // A payload with no flag is half an answer: module #12 is the held
  // count AND safe mode, and rendering the count alone would silently
  // tell a creator nothing is being held back when it might be.
  assert.equal(isModeratorStatus({ schemaVersion: 'v1', heldCount: 3 }), false);
  // A truthy string must never become "safe mode on". Painting that
  // label over an unverified value is a claim about moderation state
  // this module has no authority to make.
  for (const bad of ['true', 'on', 1, 0, null, {}]) {
    assert.equal(
      isModeratorStatus({ schemaVersion: 'v1', heldCount: 3, safeMode: bad }),
      false,
      `safeMode ${JSON.stringify(bad)} must be rejected, never coerced`,
    );
  }
});

test('isModeratorStatus rejects a payload carrying ANY private field alongside the count (§6: never private content)', () => {
  // The query cannot produce these — its returned column set is asserted
  // to be exactly {held_count, safe_mode} in
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
      isModeratorStatus({ schemaVersion: 'v1', heldCount: 3, safeMode: false, [field]: value }),
      false,
      `a payload carrying ${field} must be rejected outright`,
    );
  }
});

test('isModeratorStatus rejects a queue-paused field — safe mode is NOT alert_queues.is_paused', () => {
  // Owner decision, 2026-09-16: safe mode is the creator's own switch
  // and is explicitly not the queue-paused flag. Safe mode having been
  // built does not make that flag publishable, so a server sending one
  // must render nothing rather than have a meaning invented for it here.
  assert.equal(isModeratorStatus({ schemaVersion: 'v1', heldCount: 3, safeMode: false, isPaused: true }), false);
  assert.equal(isModeratorStatus({ schemaVersion: 'v1', heldCount: 3, safeMode: false, paused: false }), false);
  assert.equal(isModeratorStatus({ schemaVersion: 'v1', heldCount: 3, safeMode: false, queuePaused: true }), false);
});

// --- S5.15/S5.16: the visibility predicates ------------------------------

test('hasSomethingHeld is false at zero and false for no answer, true above zero', () => {
  assert.equal(hasSomethingHeld(null), false);
  assert.equal(hasSomethingHeld({ schemaVersion: 'v1', heldCount: 0, safeMode: false }), false);
  assert.equal(hasSomethingHeld({ schemaVersion: 'v1', heldCount: 0, safeMode: true }), false);
  assert.equal(hasSomethingHeld({ schemaVersion: 'v1', heldCount: 1, safeMode: false }), true);
  assert.equal(hasSomethingHeld({ schemaVersion: 'v1', heldCount: 42, safeMode: false }), true);
});

test('hasSomethingToShow is true when something is held OR safe mode is on, and false only when both are quiet', () => {
  // Safe mode alone is enough. It is the REASON nothing is reaching the
  // overlay, and a creator staring at a silent canvas with no indication
  // why is the failure this card exists to prevent.
  assert.equal(hasSomethingToShow(null), false);
  assert.equal(hasSomethingToShow({ schemaVersion: 'v1', heldCount: 0, safeMode: false }), false);
  assert.equal(hasSomethingToShow({ schemaVersion: 'v1', heldCount: 0, safeMode: true }), true);
  assert.equal(hasSomethingToShow({ schemaVersion: 'v1', heldCount: 3, safeMode: false }), true);
  assert.equal(hasSomethingToShow({ schemaVersion: 'v1', heldCount: 3, safeMode: true }), true);
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

// --- The safe-mode half of the label -------------------------------------

test('formatSafeModeLabel reads "safe mode on", and there is no "off" string at all', () => {
  assert.equal(formatSafeModeLabel(), 'safe mode on');
  // Off is the normal state of the product and is reported by the card
  // not being there. An "off" string would be the all-clear copy this
  // module deliberately does not write.
  assert.equal(formatModeratorStatusLabel({ schemaVersion: 'v1', heldCount: 0, safeMode: false }), '');
});

test('formatModeratorStatusLabel puts safe mode FIRST when both are true, because it is the cause', () => {
  assert.equal(
    formatModeratorStatusLabel({ schemaVersion: 'v1', heldCount: 3, safeMode: true }),
    'safe mode on · 3 held for review',
  );
  assert.equal(
    formatModeratorStatusLabel({ schemaVersion: 'v1', heldCount: 1, safeMode: true }),
    'safe mode on · 1 held for review',
  );
});

test('formatModeratorStatusLabel reports each half alone when only one is true', () => {
  assert.equal(formatModeratorStatusLabel({ schemaVersion: 'v1', heldCount: 0, safeMode: true }), 'safe mode on');
  assert.equal(formatModeratorStatusLabel({ schemaVersion: 'v1', heldCount: 5, safeMode: false }), '5 held for review');
  assert.equal(formatModeratorStatusLabel(null), '');
});

test('no label this module can produce carries all-clear or celebratory copy', () => {
  // There is deliberately no quiet-state branch: the module checks
  // hasSomethingToShow first and simply does not render. Asserting the
  // absence of the words here keeps someone from "helpfully" adding one
  // later without also revisiting the recorded decision.
  const everyLabel = [
    formatModeratorStatusLabel(null),
    formatModeratorStatusLabel({ schemaVersion: 'v1', heldCount: 0, safeMode: false }),
    formatModeratorStatusLabel({ schemaVersion: 'v1', heldCount: 0, safeMode: true }),
    formatModeratorStatusLabel({ schemaVersion: 'v1', heldCount: 9, safeMode: false }),
    formatModeratorStatusLabel({ schemaVersion: 'v1', heldCount: 9, safeMode: true }),
    formatHeldLabel(0),
    formatHeldLabel(9),
  ];
  for (const label of everyLabel.map((l) => l.toLowerCase())) {
    for (const forbidden of ['all clear', 'nothing', 'great', 'well done', 'clean', 'paused', 'safe mode off']) {
      assert.equal(label.includes(forbidden), false, `"${label}" must not contain "${forbidden}"`);
    }
  }
});

// --- The type carries the flag, and no queue-lifecycle slot --------------

test('ModeratorStatus declares exactly three keys, including safeMode and no paused field — a compile-time check', () => {
  type HasKey<K extends string> = K extends keyof ModeratorStatus ? true : false;
  const safeModePresent: HasKey<'safeMode'> = true;
  const isPausedAbsent: HasKey<'isPaused'> = false;
  assert.equal(safeModePresent, true);
  assert.equal(isPausedAbsent, false);
  const sample: ModeratorStatus = { schemaVersion: 'v1', heldCount: 1, safeMode: false };
  assert.deepEqual(Object.keys(sample), ['schemaVersion', 'heldCount', 'safeMode']);
});
