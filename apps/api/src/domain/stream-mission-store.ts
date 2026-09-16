// PRF-02 slice 5, §6 catalogue module #9: Stream Mission Card
// (packages/db/migrations/0135_v1_prf02_slice5_stream_mission.sql).
//
// SESSION-BOUNDED, NOT CLOCK-BOUNDED (owner decision, §6 module table row
// 9, 2026-09-16). There is deliberately NO duration, timer, expiry,
// deadline or endsAt field anywhere in this file. A mission runs until the
// creator ends it or the overlay session rendering it ends; `endedAt`
// below is a RECORD of when the creator ended it, never a schedule. If a
// future edit needs a duration here, that is a product decision to take
// back to the owner, not a constant to choose in this file.
//
// ONE CREATOR-AUTHORED TEXT FIELD. `objective`, bounded 1-120 characters,
// reusing the already-decided challenge-title bound (migration 0109 line
// 67). There is no separate title field and no description field.
//
// NO VIEWER, PAYMENT OR PERSONAL-DATA CLASS. The overlay projection
// (OverlayStreamMission) carries missionId, objective and startedAt only
// -- no identity of any kind, per §12.7.

/** The objective bound, stated once. Identical to public.challenges.title's
 *  own `between 1 and 120` (migration 0109 line 67) because it IS that
 *  decision, reused -- not a new number chosen here. */
export const STREAM_MISSION_OBJECTIVE_MIN_LENGTH = 1;
export const STREAM_MISSION_OBJECTIVE_MAX_LENGTH = 120;

/** Creator/dashboard-facing projection of the CURRENT mission. */
export type StreamMission = {
  schemaVersion: 'v1';
  missionId: string;
  objective: string;
  startedAt: string;
  /** When the creator ended it. Always null for a mission returned as
   *  current -- present on the type because the store's row shape carries
   *  it, never a scheduled end. */
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Overlay/browser-source projection. Three fields, §12.7 bounded. No
 *  identity, no end-shaped field. */
export type OverlayStreamMission = {
  schemaVersion: 'v1';
  missionId: string;
  objective: string;
  startedAt: string;
};

export type StartStreamMissionResult =
  | { outcome: 'ok'; mission: StreamMission }
  // A mission is already running for this channel. Deliberately NOT a
  // silent supersede -- see 0135's header.
  | { outcome: 'conflict' }
  | { outcome: 'forbidden' }
  | { outcome: 'invalid' };

export type EndStreamMissionResult =
  | { outcome: 'ok' }
  // Not-found and not-authorised are the same answer, deliberately.
  | { outcome: 'not_found' };

export function isValidStreamMissionObjective(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= STREAM_MISSION_OBJECTIVE_MIN_LENGTH
    && value.length <= STREAM_MISSION_OBJECTIVE_MAX_LENGTH;
}

// Creator/dashboard-facing: authenticated by session, scoped to a channel
// the caller belongs to. Mirrors MasterCanvasStore's shape. There is no
// delete method and no update-objective method: a mission is started and
// ended, and ended missions stay durable (§12.6).
export interface StreamMissionStore {
  getCurrent(userId: string, channelId: string): Promise<StreamMission | null>;
  start(userId: string, channelId: string, objective: string): Promise<StartStreamMissionResult>;
  end(userId: string, channelId: string, missionId: string): Promise<EndStreamMissionResult>;
}

// Overlay/browser-source-facing: authenticated by the overlay session
// bearer token, exactly like OverlayGoalStore/OverlayChallengeStore.
export interface StreamMissionOverlayStore {
  getForOverlay(token: string, overlayId: string): Promise<OverlayStreamMission | null>;
}
