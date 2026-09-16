// PRF-02: Master Canvas as the runtime (packages/db/migrations/0131).
// This file carries only the SERVER-OWNED entitlement half -- the §30.3
// module cap (Free 2 / Pro 5 / Creator 12 / Studio all) and the durable
// per-channel module configuration it gates. The runtime itself (single
// connection, single rAF loop, per-module error boundaries, bounded DOM)
// is client-side (apps/web/app/overlay/canvas/) and owns no store.
//
// CATALOGUE: all 20 §6 modules are configurable and cap-counted from day
// one -- this task's client only ships renderers for two of them
// ('supporter_ticker', 'community_goal_ladder'), but the cap must already
// be real for every future module, not retrofitted later.

export const MASTER_CANVAS_MODULE_KEYS = [
  'support_theater', 'community_goal_ladder', 'tug_of_war_vote', 'boss_fight',
  'reaction_cloud', 'safe_soundboard_alert', 'supporter_ticker', 'challenge_board',
  'stream_mission_card', 'qr_smart_card', 'sponsor_card', 'moderator_status_card',
  'milestone_celebration', 'vertical_stream_layout', 'stream_health_widget',
  'lobby_status', 'giveaway_tournament_card', 'now_playing', 'chat', 'media_meme_queue',
] as const;

export type MasterCanvasModuleKey = typeof MASTER_CANVAS_MODULE_KEYS[number];

export function isMasterCanvasModuleKey(value: unknown): value is MasterCanvasModuleKey {
  return typeof value === 'string' && (MASTER_CANVAS_MODULE_KEYS as readonly string[]).includes(value);
}

// The module keys this slice actually renders. Kept separate from the
// full catalogue above: MASTER_CANVAS_MODULE_KEYS is what the SERVER will
// accept and cap-count; this is what the CLIENT runtime currently knows
// how to mount. A module can be configured (and cap-counted) long before
// a renderer for it ships. PRF-02 slice 2 adds module #3 (Tug-of-War
// Vote) and module #4 (Boss Fight) to the two slice-1 shipped.
export const MASTER_CANVAS_BUILT_MODULE_KEYS = ['supporter_ticker', 'community_goal_ladder', 'tug_of_war_vote', 'boss_fight'] as const;
export type MasterCanvasBuiltModuleKey = typeof MASTER_CANVAS_BUILT_MODULE_KEYS[number];

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
