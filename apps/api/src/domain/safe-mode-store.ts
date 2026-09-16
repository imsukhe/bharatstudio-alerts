// PRF-02, §6 module #12: SAFE MODE -- the creator's own moderation
// switch (packages/db/migrations/0138_v1_prf02_safe_mode.sql).
//
// Authority: bharatstudio-requirements/reviews/
// 2026-09-16-prf-02-slice-6-owner-decisions.md decision 3, written into
// FULL-PRODUCT-DEFINITION.md §6's module table. Task record:
// bharatstudio-requirements/active/tasks/PRF-02-safe-mode.md.
//
// THE WHOLE STATE IS ONE BOOLEAN, AND THAT IS DELIBERATE. Safe mode has
// a switch, not knobs. There is no `reason`, no `expiresAt`, no
// `durationSeconds`, no `threshold`, no `windowSeconds` and no
// `triggeredBy` anywhere in this file -- and there must never be one
// without a fresh owner decision, because safe mode is NEVER automatic:
// no spike detection, no rejection-rate heuristic, no signal of any kind
// engages it. A creator turns it on and turns it off.
//
// IT IS NOT alert_queues.is_paused. That flag is a queue lifecycle
// state and is a different thing. Nothing in this file, its SQL store,
// or migration 0138 reads it.
//
// WHAT IT DOES. While it is on, a newly created alert delivery for the
// channel is written `held` rather than `ready` -- decided in exactly one
// place, app_private.initial_delivery_status (0138), which the three
// functions that insert deliveries call instead of writing the literal
// themselves.
//
// WHAT TURNING IT OFF DOES. Nothing to alerts already held. They stay
// held with their existing hold_reason and are reviewed one at a time
// through the existing app_private.apply_moderation_action path. There
// is no bulk release in this interface because there is no bulk release
// decided, and inventing one would fire an unknown number of unreviewed
// alerts onto a live broadcast on a switch flip.
//
// NEVER TIER-GATED (§12.6). Storing, viewing and changing a durable
// creator record is available at every tier. The §30.3 module cap
// governs only whether the Canvas RENDERS the Moderator Status Card.
// There is no tier check in this interface, its implementation, or its
// routes.

/** The creator-facing projection. One field, because the state is one bit. */
export type ChannelSafeMode = {
  schemaVersion: 'v1';
  enabled: boolean;
};

export type SafeModeResult =
  | { outcome: 'ok'; safeMode: ChannelSafeMode }
  // Not a member with the owner/admin role, OR the channel does not
  // exist, OR it is closed. One indistinguishable answer, by design --
  // the route maps it to 404, never a 403 that would confirm the channel
  // exists.
  | { outcome: 'not_found' };

// Creator/dashboard-facing: authenticated by session, scoped to a
// channel the caller owns or administers. Mirrors StreamMissionStore's
// shape. There is no "toggle" method: `set` takes the value, so turning
// safe mode ON and turning it OFF are the same code path and cannot
// drift apart, and a client that has lost track of the current state
// cannot flip it by accident.
export interface SafeModeStore {
  get(userId: string, channelId: string): Promise<SafeModeResult>;
  set(userId: string, channelId: string, enabled: boolean): Promise<SafeModeResult>;
}
