/*
 * Client-side display catalogue for the L24 Companion action catalogue
 * (17 actions / 4 groups: alerts, obs, mirror, stream).
 *
 * This is NOT a sixth source of truth for server enforcement — the server
 * (apps/api/src/routes/companion.ts + migration 0089) is authoritative on
 * which actions exist, their group, entitlement and activation. This file
 * only carries what the picker UI needs to *render* the catalogue: a
 * human label, a one-line description, and what kind of target (if any)
 * the action needs so the picker can collect it instead of offering a
 * free-text field that pretends to configure something it cannot.
 *
 * Group membership here must stay consistent with the server's ACTION_GROUPS
 * (see bharatstudio-alerts/scripts/companion-action-catalogue-drift-check.mjs,
 * which compares the five server/client sources — this display list is
 * deliberately NOT one of those five, since it carries no enforcement).
 */
import type { CompanionAction } from '../lib/api';

export type CompanionActionGroup = 'alerts' | 'obs' | 'mirror' | 'stream';

// What a slot assigning this action needs to collect beyond the action
// name itself. 'queue' reuses the channel's existing active-queue picker
// (targetId = queue UUID, no targetLabel). Every other kind writes into
// the single bounded `targetLabel` string the API contract provides;
// 'sceneAndItem' composes two fields (scene name + numeric scene-item id)
// into one encoded targetLabel — see `encodeSceneAndItem` below.
export type ActionTargetKind = 'queue' | 'sceneName' | 'sceneAndItem' | 'inputName' | 'transitionName' | 'none';

export type CatalogueEntry = {
  action: CompanionAction;
  group: CompanionActionGroup;
  label: string;
  description: string;
  target: ActionTargetKind;
};

export const ACTION_CATALOGUE: CatalogueEntry[] = [
  { action: 'pause_queue', group: 'alerts', label: 'Pause queue', description: 'Hold new display activity while accepted records remain durable.', target: 'queue' },
  { action: 'resume_queue', group: 'alerts', label: 'Resume queue', description: 'Allow ready deliveries to become visible again.', target: 'queue' },
  { action: 'send_test_alert', group: 'alerts', label: 'Send test alert', description: 'Create a bounded synthetic alert for the selected channel.', target: 'queue' },

  { action: 'obs_set_scene', group: 'obs', label: 'Set OBS scene', description: 'Switch OBS to a named program scene.', target: 'sceneName' },
  { action: 'obs_toggle_source', group: 'obs', label: 'Toggle OBS source', description: 'Show or hide one source item within a scene.', target: 'sceneAndItem' },
  { action: 'obs_toggle_mute', group: 'obs', label: 'Toggle input mute', description: 'Mute or unmute a named OBS audio input.', target: 'inputName' },
  { action: 'obs_start_stream', group: 'obs', label: 'Start OBS stream', description: 'Start the stream output from OBS.', target: 'none' },
  { action: 'obs_stop_stream', group: 'obs', label: 'Stop OBS stream', description: 'Stop the stream output from OBS.', target: 'none' },
  { action: 'obs_start_record', group: 'obs', label: 'Start OBS recording', description: 'Start local recording in OBS.', target: 'none' },
  { action: 'obs_stop_record', group: 'obs', label: 'Stop OBS recording', description: 'Stop local recording in OBS.', target: 'none' },
  { action: 'obs_save_replay_buffer', group: 'obs', label: 'Save replay buffer', description: 'Save the OBS replay buffer to disk.', target: 'none' },
  { action: 'obs_set_transition', group: 'obs', label: 'Set scene transition', description: 'Switch OBS to a named scene transition.', target: 'transitionName' },

  { action: 'mirror_start', group: 'mirror', label: 'Start Mirror', description: 'Begin mirroring this channel to the paired device.', target: 'none' },
  { action: 'mirror_stop', group: 'mirror', label: 'Stop Mirror', description: 'End the active Mirror session.', target: 'none' },
  { action: 'mirror_screenshot', group: 'mirror', label: 'Mirror screenshot', description: 'Capture a still frame from the active Mirror session.', target: 'none' },

  { action: 'stream_go_live', group: 'stream', label: 'Go live', description: 'Start the BharatStudio Stream session.', target: 'none' },
  { action: 'stream_end', group: 'stream', label: 'End stream', description: 'End the active BharatStudio Stream session.', target: 'none' },
];

export const GROUP_ORDER: CompanionActionGroup[] = ['alerts', 'obs', 'mirror', 'stream'];
export const GROUP_LABELS: Record<CompanionActionGroup, string> = {
  alerts: 'Alerts',
  obs: 'OBS',
  mirror: 'Mirror',
  stream: 'Stream',
};

export function catalogueEntry(action: CompanionAction): CatalogueEntry | undefined {
  return ACTION_CATALOGUE.find((entry) => entry.action === action);
}

const printableAscii = /^[\x20-\x7E]+$/;

function boundedText(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 200 || !printableAscii.test(trimmed)) return null;
  return trimmed;
}

// Composes an OBS scene name + numeric scene-item id into the single
// bounded targetLabel string the API contract carries (obs_toggle_source
// has no separate numeric field — see migration 0089's targetLabel
// discriminator). Delimiter is '#', disallowed inside a bare scene name
// here so decoding stays unambiguous.
export function encodeSceneAndItem(sceneName: string, sceneItemId: number): string | null {
  const scene = boundedText(sceneName);
  if (scene === null || scene.includes('#')) return null;
  if (!Number.isInteger(sceneItemId) || sceneItemId < 1 || sceneItemId > 1_000_000) return null;
  const label = `${scene}#${sceneItemId}`;
  return label.length <= 200 ? label : null;
}

export function decodeSceneAndItem(targetLabel: string): { sceneName: string; sceneItemId: number } | null {
  const hashIndex = targetLabel.lastIndexOf('#');
  if (hashIndex < 1 || hashIndex === targetLabel.length - 1) return null;
  const sceneName = targetLabel.slice(0, hashIndex);
  const digits = targetLabel.slice(hashIndex + 1);
  if (!/^[1-9][0-9]*$/.test(digits)) return null;
  return { sceneName, sceneItemId: Number(digits) };
}

/**
 * Validates and normalises whatever the picker collected for a given
 * target kind into the single targetLabel string the API accepts. Returns
 * null when the input is incomplete or out of bounds — callers must not
 * let the slot be added until this returns a string.
 */
export function buildTargetLabel(target: ActionTargetKind, input: { text?: string; sceneItemId?: string }): string | null {
  switch (target) {
    case 'queue':
    case 'none':
      return null;
    case 'sceneName':
    case 'inputName':
    case 'transitionName':
      return input.text !== undefined ? boundedText(input.text) : null;
    case 'sceneAndItem': {
      if (input.text === undefined || input.sceneItemId === undefined) return null;
      if (!/^[1-9][0-9]*$/.test(input.sceneItemId.trim())) return null;
      return encodeSceneAndItem(input.text, Number(input.sceneItemId.trim()));
    }
  }
}

/** Next free slot index within the tier's slot ladder, or null if full. */
export function nextFreeSlotIndex(maxSlots: number, takenIndexes: readonly number[]): number | null {
  const taken = new Set(takenIndexes);
  for (let index = 1; index <= maxSlots; index += 1) {
    if (!taken.has(index)) return index;
  }
  return null;
}
