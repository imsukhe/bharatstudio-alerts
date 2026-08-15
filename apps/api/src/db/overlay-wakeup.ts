import postgres, { type Sql } from 'postgres';
import type { OverlayWakeup, OverlayWakeupHealth } from '../domain/overlay-wakeup.js';

const CHANNEL = 'bharatstudio_overlay_events';
const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

type ListenClient = {
  listen(channel: string, onnotify: (value: string) => void, onlisten?: () => void): Promise<unknown>;
  end(options?: { timeout?: number }): Promise<void>;
};

type WakeupOptions = {
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
};

export function createOverlayWakeup(client: ListenClient, options: WakeupOptions = {}): OverlayWakeup {
  const reconnectDelayMs = Math.max(1, options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS);
  const maxReconnectDelayMs = Math.max(reconnectDelayMs, options.maxReconnectDelayMs ?? MAX_RECONNECT_DELAY_MS);
  const waiters = new Set<() => void>();
  let closed = false;
  let connected = false;
  let reconnects = 0;
  let failures = 0;
  let delay = reconnectDelayMs;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  const notify = (raw: string) => {
    try {
      JSON.parse(raw);
      for (const resolve of waiters) resolve();
      waiters.clear();
    } catch {
      // Notifications are only wake-ups. A malformed notification cannot
      // affect durable replay or make the request fail open.
    }
  };

  const scheduleReconnect = () => {
    if (closed || reconnectTimer) return;
    const currentDelay = delay;
    delay = Math.min(maxReconnectDelayMs, delay * 2);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, currentDelay);
    reconnectTimer.unref?.();
  };

  const connect = () => {
    if (closed) return;
    connected = false;
    try {
      const request = client.listen(CHANNEL, notify, () => {
        connected = true;
        delay = reconnectDelayMs;
      });
      // postgres.js resolves listen() after the LISTEN command is registered;
      // it does not resolve when the connection later closes. Treating a
      // successful registration as disconnect would immediately mark every
      // real listener unhealthy and schedule a reconnect loop. Registration
      // failure is the only setup failure surfaced by this boundary; the
      // postgres.js listener owns reconnecting a dropped socket.
      void request.catch(() => {
        if (closed) return;
        connected = false;
        failures += 1;
        reconnects += 1;
        scheduleReconnect();
      });
    } catch {
      failures += 1;
      reconnects += 1;
      scheduleReconnect();
    }
  };

  connect();

  return {
    wait(_overlayId, timeoutMs, signal) {
      return new Promise((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onAbort = () => finish();
        const finish = () => {
          if (settled) return;
          settled = true;
          waiters.delete(finish);
          if (timer) clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        if (signal?.aborted) {
          finish();
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        waiters.add(finish);
        timer = setTimeout(finish, timeoutMs);
        timer.unref?.();
      });
    },
    health(): OverlayWakeupHealth {
      return { connected, reconnects, failures };
    },
    async close() {
      closed = true;
      connected = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      for (const resolve of waiters) resolve();
      waiters.clear();
      await client.end({ timeout: 5 });
    },
  };
}

export function createDirectOverlayWakeup(databaseUrlDirect: string): OverlayWakeup {
  const sql: Sql = postgres(databaseUrlDirect, { max: 1, prepare: false });
  // Notifications identify a committed event/channel, not every overlay
  // session that may need to replay it. Wake all current streams and let each
  // stream perform its own token/channel-scoped durable replay. This is a
  // wake-up optimisation only; an unrelated wake-up is harmless.
  return createOverlayWakeup(sql);
}
