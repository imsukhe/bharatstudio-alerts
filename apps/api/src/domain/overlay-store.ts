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

export interface OverlayStore {
  create(userId: string, channelId: string): Promise<OverlaySession>;
  revoke(userId: string, overlayId: string): Promise<boolean>;
  rotate(userId: string, overlayId: string): Promise<OverlaySession | null>;
  replay(token: string, overlayId: string, lastEventId: string | undefined, limit: number): Promise<OverlayEvent[] | null>;
  acknowledge(token: string, overlayId: string, cursor: string, eventId: string): Promise<boolean>;
}
