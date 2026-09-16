// PRF-02, §6 module #12: Moderator Status Card. Slice 5 built the held
// half; safe mode (migration 0138) completes it.
//
// THE WHOLE TYPE IS ONE NUMBER AND ONE BOOLEAN, AND THAT IS THE POINT.
// §6 requires "never private content" and the owner's 2026-09-16
// decision requires that it be a property of the query rather than of
// the renderer: app_private.list_overlay_moderator_status (migration
// 0138) returns exactly `held_count bigint, safe_mode boolean`, so this
// domain type has exactly two data fields. There is nowhere in this
// shape for a supporter name, a message, an amount, a delivery id, a
// queue id or a viewer identifier to live -- not "we chose not to
// populate it", but "the field does not exist".
//
// `safeMode` IS THE CREATOR'S OWN SWITCH, NOT A QUEUE FLAG. Owner
// decision, 2026-09-16 (FULL-PRODUCT-DEFINITION.md §6 module table, and
// reviews/2026-09-16-prf-02-slice-6-owner-decisions.md decision 3): safe
// mode is a per-channel moderation state the creator turns on and off,
// and while it is on incoming alerts route to `held` instead of `ready`.
// It is NEVER automatic -- no spike detection, no rejection-rate
// heuristic, no signal of any kind engages it -- and it is explicitly
// NOT alert_queues.is_paused, which remains a different thing this path
// still never reads.
//
// HELD ALERT DELIVERIES, NOT CHAT MESSAGES. `heldCount` counts rows in
// event_outbox_deliveries with status 'held' -- paid alerts awaiting a
// moderator. It is not a live-chat held-messages queue, which is a
// different system's different number. The renderer labels it "held for
// review" for exactly this reason.

export type ModeratorStatus = {
  schemaVersion: 'v1';
  heldCount: number;
  safeMode: boolean;
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
// on a broadcast overlay is worse than an absent card. A `safeMode` that
// is not a boolean is treated the same way and is NEVER coerced: a
// truthy string would paint "safe mode on" over a state nobody verified,
// which is a claim about moderation this layer has no business making.
export function projectModeratorStatus(status: ModeratorStatus | null): ModeratorStatus | null {
  if (!status) return null;
  const heldCount = status.heldCount;
  if (typeof heldCount !== 'number' || !Number.isSafeInteger(heldCount) || heldCount < 0) return null;
  const safeMode = status.safeMode;
  if (typeof safeMode !== 'boolean') return null;
  return { schemaVersion: 'v1', heldCount, safeMode };
}
