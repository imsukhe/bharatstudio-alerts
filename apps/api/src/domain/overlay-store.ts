export type OverlaySession = {
  schemaVersion: 'v1';
  overlayId: string;
  expiresAt: string;
  streamUrl: string;
};

export type OverlayEvent = {
  schemaVersion: 'v1';
  cursor: string;
  eventId: string;
  eventType: 'alert.ready' | 'alert.update' | 'alert.hold' | 'alert.complete' | 'resync.required';
  traceId: string;
  createdAt: string;
  payload: Record<string, unknown>;
};

// RT-02 §3.2(a): the channel a session belongs to, resolved from its own
// token on every wake. Never inherited from another session.
export type OverlaySessionRef = {
  channelId: string;
};

// RT-02 §3.2(b): the per-channel, per-cursor row shape a shared (deduplicated)
// replay can safely hand to more than one session. `ttsAudioArtifactId` is
// the resolved artifact id only — never a URL, which would otherwise bake in
// whichever session's overlayId happened to run the query
// (migration 0127 / app_private.get_overlay_events). Each session composes
// its own `ttsAudioUrl` from this id and its own overlayId — see
// `composeOverlayEvent`.
export type RawOverlayEvent = {
  cursor: string;
  eventId: string;
  eventType: OverlayEvent['eventType'];
  traceId: string;
  createdAt: string;
  payload: Record<string, unknown>;
  ttsAudioArtifactId: string | null;
};

export interface OverlayStore {
  create(userId: string, channelId: string): Promise<OverlaySession>;
  revoke(userId: string, overlayId: string): Promise<boolean>;
  rotate(userId: string, overlayId: string): Promise<OverlaySession | null>;
  replay(token: string, overlayId: string, lastEventId: string | undefined, limit: number): Promise<OverlayEvent[] | null>;
  acknowledge(token: string, overlayId: string, cursor: string, eventId: string): Promise<boolean>;
  /**
   * RT-02 §3.2(a). A cheap, session-scoped authorization check with no event
   * read — every session must call this on every wake before it is given
   * any events, so a revoked/expired session stops immediately regardless of
   * whether it was a leader or a follower of a shared replay. Optional: a
   * store that omits it opts this connection out of channel-keyed fanout and
   * per-channel dedup, and the route falls back to the pre-RT-02 per-session
   * poll shape for it (test doubles only — the real SQL store always
   * implements this).
   */
  resolveSession?(token: string, overlayId: string): Promise<OverlaySessionRef | null>;
  /**
   * RT-02 §3.2(b). Same authorization/cursor semantics as `replay`, but
   * returns rows before any session-specific URL is composed, so the result
   * can be shared (single-flight, keyed by channelId+cursor+limit) across
   * every session on the same channel without leaking one session's
   * overlayId into another's payload. Optional for the same reason as
   * `resolveSession`.
   */
  replayRaw?(token: string, overlayId: string, lastEventId: string | undefined, limit: number): Promise<RawOverlayEvent[] | null>;
}

// Pure composition, shared by the SQL store (`replay`, built on `replayRaw`)
// and the route's coalesced replay path. The SSE payload keeps exactly the
// keys it always had, including `ttsAudioUrl: null` when there is no
// artifact — only how that value gets computed moves out of SQL.
export function composeOverlayEvent(row: RawOverlayEvent, overlayId: string): OverlayEvent {
  return {
    schemaVersion: 'v1',
    cursor: row.cursor,
    eventId: row.eventId,
    eventType: row.eventType,
    traceId: row.traceId,
    createdAt: row.createdAt,
    payload: {
      ...row.payload,
      ttsAudioUrl: row.ttsAudioArtifactId ? `/v1/overlay-audio/${overlayId}/${row.ttsAudioArtifactId}` : null,
    },
  };
}
