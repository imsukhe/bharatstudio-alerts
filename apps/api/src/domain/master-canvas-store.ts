// PRF-02: Master Canvas as the runtime (packages/db/migrations/0131).
// This file carries only the SERVER-OWNED entitlement half -- the §30.3
// module cap (Free 2 / Pro 5 / Creator 12 / Studio all) and the durable
// per-channel module configuration it gates. The runtime itself (single
// connection, single rAF loop, per-module error boundaries, bounded DOM)
// is client-side (apps/web/app/overlay/canvas/) and owns no store.
//
// CATALOGUE: sixteen §6 modules are configurable and cap-counted.
//
// MIGRATION 0147 RETIRED FOUR DEAD KEYS from the twenty this catalogue
// used to list: 'now_playing', 'chat', 'stream_health_widget' and
// 'vertical_stream_layout'. The first three are permanently dead (AUD-11
// stands for now_playing; chat was never a canvas module -- the
// 2026-09-17 §6 #19 decision; stream health moved to the dashboard), and
// the fourth -- Vertical Stream Layout, §6 module #14 -- is NOT a module
// at all: it is a per-channel canvas SETTING (public.channels.
// canvas_layout, migration 0147) that arranges already-built modules
// into a fixed 9:16 arrangement. Counting it here would spend a §30.3 cap
// slot on *being vertical*, which migration 0147's header explains at
// length. Its own store lives in domain/canvas-layout-store.ts, not
// here -- deliberately, since it is not one of these sixteen keys.
export const MASTER_CANVAS_MODULE_KEYS = [
  'support_theater', 'community_goal_ladder', 'tug_of_war_vote', 'boss_fight',
  'reaction_cloud', 'safe_soundboard_alert', 'supporter_ticker', 'challenge_board',
  'stream_mission_card', 'qr_smart_card', 'sponsor_card', 'moderator_status_card',
  'milestone_celebration', 'lobby_status', 'giveaway_tournament_card', 'media_meme_queue',
] as const;

export type MasterCanvasModuleKey = typeof MASTER_CANVAS_MODULE_KEYS[number];

export function isMasterCanvasModuleKey(value: unknown): value is MasterCanvasModuleKey {
  return typeof value === 'string' && (MASTER_CANVAS_MODULE_KEYS as readonly string[]).includes(value);
}

// REMOVED 2026-09-16: MASTER_CANVAS_BUILT_MODULE_KEYS / MasterCanvasBuiltModuleKey.
//
// It listed which modules the client runtime could mount, went stale in
// slices 3, 4 and 5 (four keys against the client's nine), was referred
// forward three times as "stale, to fix" -- and had ZERO consumers. Nothing
// in apps/, packages/ or any test ever imported it.
//
// Deleted rather than updated, because updating it would have recreated the
// real defect: a second, server-side source of truth for a fact only the
// client can know. Which modules can be MOUNTED is a property of the web
// runtime, and apps/web/app/overlay/canvas/[overlayId]/page.tsx's
// BUILT_MODULE_KEYS is where it belongs. The server deliberately accepts and
// cap-counts the whole catalogue (MASTER_CANVAS_MODULE_KEYS above) precisely
// so a module can be configured before its renderer ships -- so the server
// has no use for a "built" list at all.
//
// A stale list with no consumers is worse than no list: it reads as
// authoritative to the next person and is wrong.

export type MasterCanvasModuleInactiveReason = 'disabled' | 'tier_module_cap';

export type MasterCanvasModule = {
  schemaVersion: 'v1';
  moduleKey: MasterCanvasModuleKey;
  enabled: boolean;
  active: boolean;
  inactiveReason: MasterCanvasModuleInactiveReason | null;
  createdAt: string;
  updatedAt: string;
};

export type UpsertMasterCanvasModuleResult =
  | { outcome: 'ok'; module: MasterCanvasModule }
  | { outcome: 'forbidden' }
  | { outcome: 'invalid' };

// Creator/dashboard-facing: authenticated by session, scoped to a channel
// the caller belongs to. Mirrors GoalStore's shape (list/never a delete
// method -- §12.6 durable records means there is no delete path here at
// all, only `enabled`).
export interface MasterCanvasStore {
  list(userId: string, channelId: string): Promise<MasterCanvasModule[]>;
  upsert(userId: string, channelId: string, moduleKey: MasterCanvasModuleKey, enabled: boolean): Promise<UpsertMasterCanvasModuleResult>;
}

// Overlay/browser-source-facing: authenticated by the overlay session
// bearer token, exactly like OverlayGoalStore/interactions.ts's widget
// reads. Returns ONLY the module keys active right now -- no config, no
// disabled/over-cap module, no reason. That detail is creator-facing only
// (MasterCanvasStore.list above).
export interface MasterCanvasOverlayStore {
  listActiveForOverlay(token: string, overlayId: string): Promise<MasterCanvasModuleKey[]>;
}
