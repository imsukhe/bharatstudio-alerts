/*
 * Pure, DOM-free helpers for the Moderator Status Card module (§6 #12,
 * HELD HALF ONLY) — same pattern as ./tug-of-war-vote-logic.ts and
 * ../../widgets/goal/goal-widget-logic.ts: testable directly, no browser
 * or useParams context needed.
 *
 * WHAT THIS CARD IS, AND THE TWO THINGS IT IS NOT.
 *
 * It is the number of this channel's alert deliveries currently HELD for
 * a moderator's decision — `event_outbox_deliveries.status = 'held'`,
 * read through `app_private.list_overlay_moderator_status` (migration
 * 0136). It answers one mid-stream question: "is anything stuck?"
 *
 *   1. It is NOT a chat-message count. §6's original wording said
 *      "messages held", which predates this schema and has been
 *      corrected in §6 itself. A creator reading "3 held" next to a
 *      stream could reasonably think of their platform's live-chat
 *      held-messages queue — a different system's different number — so
 *      the label here says "held for review" and never says "messages",
 *      "chat" or "comments". `moderator-status-module.test.ts` asserts
 *      that against the rendered text rather than trusting this comment.
 *
 *   2. It is NOT a safe-mode indicator, and there is no safe-mode field
 *      anywhere in this file. §6 originally paired the held count with
 *      "safe mode on"; the owner decided on 2026-09-16 that safe mode is
 *      NOT the queue-paused flag — it is a separate moderation control
 *      that does not exist in the schema and needs its own record and
 *      decision. Migration 0136 reads no queue-lifecycle column at all,
 *      and this type has nowhere to put one.
 *
 * NEVER PRIVATE CONTENT, AND IT IS NOT THIS FILE'S DOING. The snapshot
 * carries a count because the QUERY returns a count: one `held_count`
 * column, asserted in
 * `packages/db/tests/prf02_slice5_moderator_status.sql` against both the
 * declared result type and the live output. The guard below is a third
 * line — it rejects any payload carrying a key it does not expect, so a
 * server that somehow began returning a supporter name would render
 * nothing rather than render it.
 */

export type ModeratorStatus = {
  schemaVersion: 'v1';
  heldCount: number;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function exactKeys(row: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(row).length === keys.length && keys.every((key) => Object.hasOwn(row, key));
}

/**
 * Exactly the two declared keys, and a count that is a non-negative safe
 * integer. `exactKeys` is doing real work here rather than being
 * defensive boilerplate: it is what makes an unexpected extra field
 * (a name, a message, an amount, a "safeMode" flag) fail the guard
 * outright instead of being silently ignored and then, one careless
 * refactor later, rendered.
 */
export function isModeratorStatus(value: unknown): value is ModeratorStatus {
  const row = record(value);
  if (!row || !exactKeys(row, ['schemaVersion', 'heldCount'])) return false;
  if (row.schemaVersion !== 'v1') return false;
  const heldCount = row.heldCount;
  return typeof heldCount === 'number' && Number.isSafeInteger(heldCount) && heldCount >= 0;
}

/**
 * True when the card has something to say. Zero is a perfectly valid
 * answer from the server — it means "authorised, and nothing is held" —
 * but it is not something worth painting on a broadcast for the whole
 * stream, so the module hides at zero. See `formatHeldLabel`'s note and
 * `bharatstudio-requirements/active/tasks/PRF-02.md`'s Slice 5
 * "Decisions" for why there is deliberately no all-clear copy.
 */
export function hasSomethingHeld(status: ModeratorStatus | null): boolean {
  return status !== null && status.heldCount > 0;
}

/**
 * The rendered label. Singular at one, plural otherwise, and the noun is
 * left implicit on purpose — "held for review" rather than "N deliveries
 * held" or "N messages held": "deliveries" is internal vocabulary a
 * creator does not use, and "messages" is the specific wrong word this
 * module exists to avoid.
 *
 * There is no zero branch. Calling this with a zero count is a
 * programming error the module never makes — it checks
 * `hasSomethingHeld` first — and inventing an "All clear" string here
 * would be exactly the celebratory copy this slice was told not to
 * write.
 */
export function formatHeldLabel(heldCount: number): string {
  return `${heldCount} held for review`;
}
