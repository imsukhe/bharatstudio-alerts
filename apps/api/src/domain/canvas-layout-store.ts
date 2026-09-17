// PRF-02 slice 7, §6 module #14: Vertical Stream Layout
// (packages/db/migrations/0147_v1_prf02_vertical_layout.sql).
//
// A LAYOUT IS NOT A MODULE. This file is deliberately separate from
// domain/master-canvas-store.ts: MASTER_CANVAS_MODULE_KEYS there lists
// the sixteen §6 catalogue keys that consume a §30.3 cap slot, and this
// setting is not one of them (migration 0147's header explains why at
// length -- a Pro creator with five slots would otherwise spend one on
// *being vertical*). CanvasLayoutStore/CanvasLayoutOverlayStore below
// have no relationship to MasterCanvasStore/MasterCanvasOverlayStore
// beyond both backing the same Master Canvas runtime.
//
// ONE FIXED 9:16 ARRANGEMENT, NO VARIANTS (this task's own scope: "no
// variant selection, no variant system" -- that is CST-08, Phase 2). The
// arrangement itself (compact goal, QR Smart Card, Reaction Cloud -- no
// chat, no reserved gap for chat, per the owner's 2026-09-17 #19
// decision) is a client-side rendering concern
// (apps/web/app/overlay/canvas/[overlayId]/page.tsx); this type is only
// the horizontal/vertical CHOICE.
//
// THE PRO+ GATE IS SERVER-SIDE, INSIDE THE OVERLAY READ. §30.3 places
// vertical layout at Pro+, and 00_LAUNCH_SCOPE_AUTHORITY.md already
// rejects a browser-only version of this kind of gate. Storing the
// preference is never tier-gated (§12.6) -- a Free channel can configure
// 'vertical' and see it recorded -- but app_private.
// list_overlay_canvas_layout (migration 0147) evaluates
// app_private.vertical_canvas_layout_entitled INSIDE the query, so an
// unentitled channel's perfectly valid overlay token still receives one
// row back with layout: 'horizontal', never an error and never zero rows
// for that reason. CanvasLayoutOverlayStore.getForOverlay mirrors that:
// it returns exactly one CanvasLayout for a valid session (never null
// for an entitlement reason) and null ONLY for an invalid/revoked/
// expired/foreign session -- the same "nothing to paint" shape as
// SponsorCardOverlayStore, but here "nothing" never happens for a valid
// session, because the Canvas always needs SOME layout to paint.

export type CanvasLayout = 'horizontal' | 'vertical';

export function isCanvasLayout(value: unknown): value is CanvasLayout {
  return value === 'horizontal' || value === 'vertical';
}

/** Creator/dashboard-facing projection: the configured layout, plus
 *  whether vertical currently renders (so the creator UI can show a
 *  "Pro required" hint without a second, independently-wrong copy of
 *  the tier gate -- that gate stays solely inside
 *  list_overlay_canvas_layout). */
export type ChannelCanvasLayout = {
  schemaVersion: 'v1';
  layout: CanvasLayout;
  verticalEntitled: boolean;
};

/** Overlay/browser-source projection: the single value the Canvas
 *  runtime arranges its modules by. Never carries a channel id, a
 *  timestamp or the entitlement boolean -- those are creator-facing
 *  only. */
export type OverlayCanvasLayout = {
  schemaVersion: 'v1';
  layout: CanvasLayout;
};

export type SetCanvasLayoutResult =
  | { outcome: 'ok'; channelLayout: ChannelCanvasLayout }
  | { outcome: 'forbidden' }
  | { outcome: 'invalid' };

// Creator/dashboard-facing: authenticated by session, scoped to a
// channel the caller belongs to. Mirrors QrSmartCardStore's shape.
// There is no delete method: a layout is a durable single-valued
// setting (§12.6), same posture as channels.safe_mode_enabled (0138) --
// it is set, never removed.
export interface CanvasLayoutStore {
  getCurrent(userId: string, channelId: string): Promise<ChannelCanvasLayout | null>;
  set(userId: string, channelId: string, layout: CanvasLayout): Promise<SetCanvasLayoutResult>;
}

// Overlay/browser-source-facing: authenticated by the overlay session
// bearer token, exactly like QrSmartCardOverlayStore.
export interface CanvasLayoutOverlayStore {
  getForOverlay(token: string, overlayId: string): Promise<OverlayCanvasLayout | null>;
}

// The route's outbound narrowing for the overlay read -- a SECOND,
// independent projection sitting in front of the store's answer, not a
// pass-through that trusts it. Mirrors projectOverlayQrSmartCard's own
// shape: a value of the wrong type is treated as no answer at all
// (never coerced, never defaulted to 'horizontal' here -- a malformed
// answer from the store is a store bug, not a rendering decision this
// projection should paper over).
export function projectOverlayCanvasLayout(value: OverlayCanvasLayout | null): OverlayCanvasLayout | null {
  if (!value) return null;
  if (!isCanvasLayout(value.layout)) return null;
  return { schemaVersion: 'v1', layout: value.layout };
}
