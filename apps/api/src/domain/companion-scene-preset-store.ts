// CMP-20: scene presets (packages/db/migrations/0162). See that
// migration's header for the seeding decision (creator-created, upserted
// on first configure -- mirrors master_canvas_modules, 0131) and for why
// this is storage + resolution only (no one-tap "apply" dispatch route
// in this slice).

export const SCENE_PRESET_NAMES = ['gameplay', 'just_chatting', 'brb', 'sponsor', 'vertical', 'ending'] as const;
export type ScenePresetName = (typeof SCENE_PRESET_NAMES)[number];

// Copied verbatim from apps/api/src/routes/companion.ts's ACTION_GROUPS
// 'obs' group -- not re-derived, not extended. See migration 0162 header,
// "NO NEW OBS VERBS".
export const SCENE_PRESET_ACTION_TYPES = ['obs_set_scene', 'obs_toggle_source', 'obs_toggle_mute', 'obs_set_transition'] as const;
export type ScenePresetActionType = (typeof SCENE_PRESET_ACTION_TYPES)[number];

export type ScenePreset = {
  schemaVersion: 'v1';
  presetId: string;
  channelId: string;
  presetName: ScenePresetName;
  createdAt: string;
  updatedAt: string;
};

export type ScenePresetAction = {
  schemaVersion: 'v1';
  actionId: string;
  stepOrder: number;
  actionType: ScenePresetActionType;
  targetLabel: string;
};

export type UpsertScenePresetResult =
  | { outcome: 'ok'; presetId: string }
  | { outcome: 'forbidden' }
  | { outcome: 'invalid' };

export type AddScenePresetActionInput = {
  stepOrder: number;
  actionType: ScenePresetActionType;
  targetLabel: string;
};

export type AddScenePresetActionResult =
  | { outcome: 'ok'; actionId: string }
  | { outcome: 'forbidden' }
  | { outcome: 'not_found' }
  | { outcome: 'invalid' };

export interface CompanionScenePresetStore {
  upsert(userId: string, channelId: string, presetName: ScenePresetName): Promise<UpsertScenePresetResult>;
  list(userId: string, channelId: string): Promise<ScenePreset[]>;
  addAction(userId: string, channelId: string, presetId: string, input: AddScenePresetActionInput): Promise<AddScenePresetActionResult>;
  // The CMP-20 "resolution to existing actions": the ordered OBS-action
  // steps a client executes one at a time through the existing
  // /v1/channels/{channelId}/companion/actions route. Returns null when
  // the preset does not exist / is not visible to this caller.
  listActions(userId: string, channelId: string, presetId: string): Promise<ScenePresetAction[] | null>;
}
