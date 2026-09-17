/*
 * Pure, DOM-free helpers for the Vertical Stream Layout (§6 module #14,
 * migration 0147) -- same pattern as ./sponsor-card-logic.ts and
 * ./qr-smart-card-logic.ts: testable directly, no browser or useParams
 * context needed.
 *
 * A LAYOUT IS NOT A MODULE. There is no createCanvasLayoutModule() and
 * no registerModule() call for this anywhere -- see
 * [overlayId]/page.tsx's own header. This file exists only to turn one
 * fetched value (`horizontal` | `vertical`) into the class name the root
 * element wears, and to name -- in exactly one place -- which THREE
 * already-built modules the vertical arrangement contains.
 *
 * ONE FIXED 9:16 ARRANGEMENT, NO VARIANTS (this task's own scope: "no
 * variant selection, no variant system" -- that is CST-08, Phase 2).
 * There is no variant id, no aspect-ratio field and no scene concept
 * anywhere in this file.
 *
 * COMPACT GOAL, QR SMART CARD, REACTION CLOUD -- NO CHAT, NO GAP. §6's
 * row for this module says "Narrow chat, compact goal, QR, reactions",
 * superseded by the owner's 2026-09-17 #19 decision: chat was never a
 * canvas module (§4.2.1 puts chat display in the dashboard/Companion;
 * §9.1.1 forbids the third-party embed a live chat widget would need
 * inside the Master Canvas). CANVAS_LAYOUT_ARRANGED_MODULE_KEYS below is
 * exactly three keys, deliberately never four, and carries no fourth
 * placeholder/gap entry standing in for chat -- a reserved gap promises
 * something that will never arrive (this task's own instruction).
 * "Compact goal" is a CSS-only variant of the SAME community_goal_ladder
 * module every horizontal layout already renders (community-goal-ladder-
 * module.ts is untouched by this file) -- never a second goal renderer,
 * never a second fetch of goal data.
 *
 * §12.7: A NARROWER VIEWPORT MUST NEVER FETCH MORE. This file adds no
 * fetch, no subscription and no retained state of its own -- it is a
 * pure function from one already-fetched value to a class name string.
 */

export type CanvasLayout = 'horizontal' | 'vertical';

export type CanvasLayoutSnapshot = {
  schemaVersion: 'v1';
  layout: CanvasLayout;
};

/** The exactly-three §6 modules the vertical arrangement contains. No
 *  chat, and this array is the one place a fourth entry would have to
 *  be added for a chat module to appear in the vertical layout -- which
 *  is exactly why canvas-layout-logic.test.ts asserts its length is 3. */
export const CANVAS_LAYOUT_ARRANGED_MODULE_KEYS = [
  'community_goal_ladder',
  'qr_smart_card',
  'reaction_cloud',
] as const;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function exactKeys(row: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(row).length === keys.length && keys.every((key) => Object.hasOwn(row, key));
}

export function isCanvasLayout(value: unknown): value is CanvasLayout {
  return value === 'horizontal' || value === 'vertical';
}

/** Exactly the two declared keys and a recognised layout value. Rejects
 *  an unexpected extra field outright (a variant id, an aspect ratio, a
 *  channel id) -- the same `exactKeys` guard every other overlay-facing
 *  snapshot type in this directory uses. */
export function isCanvasLayoutSnapshot(value: unknown): value is CanvasLayoutSnapshot {
  const row = record(value);
  if (!row || !exactKeys(row, ['schemaVersion', 'layout'])) return false;
  if (row.schemaVersion !== 'v1') return false;
  return isCanvasLayout(row.layout);
}

/** The root element's class name for a given layout. 'horizontal' is the
 *  default and adds no modifier class, so an overlay that never receives
 *  an answer (a store outage, before the first successful fetch) renders
 *  exactly as it always has -- the additive property every other slice
 *  in this file keeps. */
export function canvasRootClassName(layout: CanvasLayout): string {
  return layout === 'vertical' ? 'master-canvas-root master-canvas-root--vertical' : 'master-canvas-root';
}
