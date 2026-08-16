export type OverlayAudio = { bytes: Buffer; mimeType: string; durationMs?: number | null };

export interface OverlayAudioStore {
  read(token: string, overlayId: string, artifactId: string): Promise<OverlayAudio | null>;
}
