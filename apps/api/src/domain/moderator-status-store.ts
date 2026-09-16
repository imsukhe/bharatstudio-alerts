// PRF-02 slice 5, §6 module #12: Moderator Status Card -- HELD HALF ONLY.
//
// THE WHOLE TYPE IS ONE NUMBER, AND THAT IS THE POINT. §6 requires
// "never private content" and the owner's 2026-09-16 decision requires
// that it be a property of the query rather than of the renderer:
// app_private.list_overlay_moderator_status (migration 0136) returns a
// single `held_count bigint` column, so this domain type has exactly one
// data field. There is nowhere in this shape for a supporter name, a
// message, an amount, a delivery id, a queue id or a viewer identifier
// to live -- not "we chose not to populate it", but "the field does not
// exist".
//
// NO SAFE-MODE FIELD. §6's original module text paired the held count
// with "safe mode on". The owner decided on 2026-09-16 that safe mode is
// NOT the queue-paused flag -- it is a separate moderation control that
// does not exist in this schema and needs its own record and decision.
// So there is deliberately no `safeMode`, no `paused`, and no
// queue-lifecycle field of any kind here, and adding one would be
// building a product decision that has not been made.
//
// HELD ALERT DELIVERIES, NOT CHAT MESSAGES. `heldCount` counts rows in
// event_outbox_deliveries with status 'held' -- paid alerts awaiting a
// moderator. It is not a live-chat held-messages queue, which is a
// different system's different number. The renderer labels it "held for
// review" for exactly this reason.

export type ModeratorStatus = {
  schemaVersion: 'v1';
  heldCount: number;
};

// Overlay-facing: authenticated by the bearer overlay-session token, not
// a session cookie. Mirrors MasterCanvasOverlayStore's own shape
// (token first, overlayId second) -- the same convention every other
// overlay store in this codebase uses.
export interface ModeratorStatusOverlayStore {
  getForOverlay(token: string, overlayId: string): Promise<ModeratorStatus | null>;
}

// The route's outbound narrowing. This is a SECOND, independent
// projection sitting in front of the store's answer, not a pass-through
// that trusts it: even if a store implementation were changed to hand up
// extra fields, only the count survives this function. One narrowing is
// a single point of failure; the query's own single-column signature and
// this are two.
//
// A count that is not a non-negative safe integer is treated as no
// answer at all rather than rendered -- a negative or fractional figure
// on a broadcast overlay is worse than an absent card.
export function projectModeratorStatus(status: ModeratorStatus | null): ModeratorStatus | null {
  if (!status) return null;
  const heldCount = status.heldCount;
  if (typeof heldCount !== 'number' || !Number.isSafeInteger(heldCount) || heldCount < 0) return null;
  return { schemaVersion: 'v1', heldCount };
}
