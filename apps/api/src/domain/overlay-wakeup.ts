export type OverlayWakeupHealth = {
  connected: boolean;
  reconnects: number;
  failures: number;
};

export type OverlayWakeupResult = 'notification' | 'timeout';

// RT-02: fanout is channel-keyed, not instance-wide. A subscription is
// created once per SSE connection (`subscribe`), scoped to that connection's
// channel, and reused for every wait in its poll loop; releasing it frees
// both the notification registration and the admission slot it holds.
export interface OverlaySubscription {
  wait(timeoutMs: number, signal?: AbortSignal): Promise<OverlayWakeupResult>;
  release(): void;
}

export interface OverlayWakeup {
  /**
   * Registers one connection against a channel. Returns `null` only when a
   * configured per-instance or per-channel admission ceiling has been
   * reached — the caller must treat that as a retryable rejection, never a
   * silent hang. Unset ceilings mean this never returns `null`.
   */
  subscribe(channelId: string): OverlaySubscription | null;
  close(): Promise<void>;
  health(): OverlayWakeupHealth;
}
