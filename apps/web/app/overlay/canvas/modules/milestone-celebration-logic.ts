/*
 * Pure, DOM-free helper for the Milestone Celebration module (§6 #13) —
 * mirrors tug-of-war-vote-logic.ts's own pattern (testable directly, no
 * browser/useParams context needed).
 *
 * PRF-02 slice 4's own §1(a): "One reusable animation fired by verified
 * state transitions" — specifically the **false→true edges** on
 * `goal.reached` (which Boss Fight rides too, since it reads the same
 * goal object as Community Goal Ladder) and on the paid vote's
 * `resolved`. Both fields already exist in the snapshots the Canvas
 * already fetches (goal-widget-logic.ts's `OverlayGoal.reached`,
 * tug-of-war-vote-logic.ts's `TugOfWarVoteTally.resolved`) — this slice
 * adds no endpoint, no query, and no event to observe them.
 *
 * THE EDGE, PRECISELY: `isRisingEdge` fires ONLY when the PREVIOUSLY
 * OBSERVED value was explicitly `false` and the new value is `true`.
 * Critically, "previously observed" starts at `undefined`, never at
 * `false` — so:
 *   - A value that is already `true` the FIRST time this module ever
 *     observes it (a fresh activation, or a reconnect that redelivers an
 *     already-true snapshot before this module had seen a `false`) is
 *     `undefined -> true`, which is NOT a rising edge and does not fire.
 *     A creator's OBS scene coming back into view on an already-completed
 *     goal must not replay a celebration for it.
 *   - `true -> true` (the value holding steady across repeated snapshots,
 *     including every re-poll while the connection is healthy and every
 *     redelivery on an ordinary reconnect) is not a rising edge either —
 *     this is what keeps the celebration from repeating while the value
 *     merely stays true.
 *   - Only `false -> true` — a genuine, observed transition — fires.
 */

export type ObservedBoolean = boolean | undefined;

export function isRisingEdge(previous: ObservedBoolean, next: boolean): boolean {
  return previous === false && next === true;
}
