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
 *   2. It is NOT a queue-paused indicator. §6 pairs the held count with
 *      "safe mode on", and `safeMode` below IS that — the creator's own
 *      per-channel switch, which routes incoming alerts to `held`
 *      instead of `ready` while it is on (owner decision, 2026-09-16;
 *      migration 0138). It is never automatic: no spike detection, no
 *      rejection-rate heuristic, no signal of any kind engages it. And
 *      it is explicitly NOT `alert_queues.is_paused`, which remains a
 *      queue lifecycle state that migration 0138 still never reads and
 *      that this type still has nowhere to put.
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
  safeMode: boolean;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function exactKeys(row: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(row).length === keys.length && keys.every((key) => Object.hasOwn(row, key));
}

/**
 * Exactly the three declared keys, a count that is a non-negative safe
 * integer, and a `safeMode` that is a real boolean. `exactKeys` is doing
 * real work here rather than being defensive boilerplate: it is what
 * makes an unexpected extra field (a name, a message, an amount, an
 * `isPaused` flag) fail the guard outright instead of being silently
 * ignored and then, one careless refactor later, rendered.
 *
 * `safeMode` is never coerced. A truthy string would paint "safe mode
 * on" over a state nothing verified — a claim about moderation this
 * module has no authority to make — so a non-boolean fails the guard and
 * the card renders nothing.
 */
export function isModeratorStatus(value: unknown): value is ModeratorStatus {
  const row = record(value);
  if (!row || !exactKeys(row, ['schemaVersion', 'heldCount', 'safeMode'])) return false;
  if (row.schemaVersion !== 'v1') return false;
  if (typeof row.safeMode !== 'boolean') return false;
  const heldCount = row.heldCount;
  return typeof heldCount === 'number' && Number.isSafeInteger(heldCount) && heldCount >= 0;
}

/**
 * True when something is held. Kept as its own predicate because the
 * held count and the safe-mode flag are independent facts and the label
 * below reports them separately.
 */
export function hasSomethingHeld(status: ModeratorStatus | null): boolean {
  return status !== null && status.heldCount > 0;
}

/**
 * True when the card has something to say at all.
 *
 * Slice 5 hid the card whenever the count was zero. Safe mode changes
 * that in exactly one direction: "safe mode is on" is itself the thing a
 * creator needs to see mid-stream, because it is the REASON nothing is
 * reaching the overlay. A creator looking at a silent canvas with no
 * indication why is the failure this module exists to prevent, so safe
 * mode alone is enough to show the card even with nothing yet held.
 *
 * Slice 5's other decision is preserved exactly: with safe mode off and
 * nothing held, this is false and the card renders nothing at all — no
 * "All clear", no "Nothing held", no tick. A permanent zero badge is
 * chrome a viewer stares at for a whole broadcast while carrying no
 * information, and a reassuring string would be a claim about moderation
 * state nothing here is authorised to make. The card's absence is the
 * answer "nothing is stuck and nothing is being held back".
 */
export function hasSomethingToShow(status: ModeratorStatus | null): boolean {
  return status !== null && (status.heldCount > 0 || status.safeMode);
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
 * would be exactly the celebratory copy this module was told not to
 * write.
 */
export function formatHeldLabel(heldCount: number): string {
  return `${heldCount} held for review`;
}

/**
 * The safe-mode half of the label. §6's own words ("safe mode on"),
 * lower-cased to sit beside the count in one line of running text.
 *
 * There is deliberately no "safe mode off" string. Off is the normal
 * state of the product and is reported by the card not being there —
 * announcing it would be the all-clear copy this module does not write.
 */
export function formatSafeModeLabel(): string {
  return 'safe mode on';
}

/**
 * The whole rendered line.
 *
 * SAFE MODE COMES FIRST when both are true, because it is the cause and
 * the count is the consequence: a creator reading "safe mode on · 3 held
 * for review" learns why those three are waiting. The separator is a
 * middot rather than a comma so neither half reads as a subordinate
 * clause of the other.
 *
 * Returns the empty string when there is nothing to say, so the caller
 * writes one text node in every case rather than branching on which
 * element to clear.
 */
export function formatModeratorStatusLabel(status: ModeratorStatus | null): string {
  if (!hasSomethingToShow(status)) return '';
  const parts: string[] = [];
  if ((status as ModeratorStatus).safeMode) parts.push(formatSafeModeLabel());
  if (hasSomethingHeld(status)) parts.push(formatHeldLabel((status as ModeratorStatus).heldCount));
  return parts.join(' · ');
}
