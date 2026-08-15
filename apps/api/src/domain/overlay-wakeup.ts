export type OverlayWakeupHealth = {
  connected: boolean;
  reconnects: number;
  failures: number;
};

export interface OverlayWakeup {
  wait(overlayId: string, timeoutMs: number, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
  health?(): OverlayWakeupHealth;
}
