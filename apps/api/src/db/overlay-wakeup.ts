import postgres, { type Sql } from 'postgres';
import type { OverlaySubscription, OverlayWakeup, OverlayWakeupHealth, OverlayWakeupResult } from '../domain/overlay-wakeup.js';

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
  // RT-02 §3.3 admission limits. Unset means no additional limit beyond the
  // platform's own Cloud Run request-concurrency cap — never invent a
  // number here; these come only from configuration.
  maxInstanceSubscribers?: number;
  maxChannelSubscribers?: number;
  // Observability hook only (RT-02 §3.4). Never a channel/overlay id.
  onNotification?: (outcome: 'routed' | 'unroutable') => void;
};

type Waiter = {
  resolve: (result: OverlayWakeupResult) => void;
  reject: (error: unknown) => void;
  finish: () => void;
};

export function createOverlayWakeup(client: ListenClient, options: WakeupOptions = {}): OverlayWakeup {
  const reconnectDelayMs = Math.max(1, options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS);
  const maxReconnectDelayMs = Math.max(reconnectDelayMs, options.maxReconnectDelayMs ?? MAX_RECONNECT_DELAY_MS);
  const maxInstanceSubscribers = options.maxInstanceSubscribers;
  const maxChannelSubscribers = options.maxChannelSubscribers;

  // Channel-keyed waiter registry (RT-02): a notification for channel A may
  // only resolve waiters registered under channel A. Nothing here is ever
  // iterated across channels except on listener failure/close, where every
  // outstanding wait — on every channel — must settle exactly as it did
  // before this change (RT-01 non-regression).
  const channelWaiters = new Map<string, Set<Waiter>>();
  // Admission counters (RT-02 §3.3), independent of the waiter registry: a
  // subscription is "alive" (and counted) for the lifetime of one SSE
  // connection, not just while it happens to be inside a wait() call.
  const channelSubscribers = new Map<string, number>();
  let totalSubscribers = 0;

  let closed = false;
  let connected = false;
  let reconnects = 0;
  let failures = 0;
  let delay = reconnectDelayMs;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  const settleAll = (settle: (waiter: Waiter) => void) => {
    const channels = [...channelWaiters.entries()];
    channelWaiters.clear();
    for (const [, waiters] of channels) {
      for (const waiter of waiters) settle(waiter);
    }
  };

  const notify = (raw: string) => {
    let channelId: unknown;
    try {
      const parsed = JSON.parse(raw) as { channelId?: unknown };
      channelId = parsed?.channelId;
    } catch {
      // A malformed notification is only ever a wake-up optimisation. It
      // must wake nobody and must never throw or affect durable replay.
      options.onNotification?.('unroutable');
      return;
    }
    if (typeof channelId !== 'string' || channelId.length === 0) {
      options.onNotification?.('unroutable');
      return;
    }
    const waiters = channelWaiters.get(channelId);
    if (!waiters || waiters.size === 0) {
      // Routed successfully (a real channel id), just nobody was waiting.
      options.onNotification?.('routed');
      return;
    }
    options.onNotification?.('routed');
    for (const waiter of [...waiters]) {
      waiter.finish();
      waiter.resolve('notification');
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

  const onListenerFailure = () => {
    if (closed) return;
    connected = false;
    failures += 1;
    reconnects += 1;
    settleAll((waiter) => {
      waiter.finish();
      waiter.reject(new Error('overlay_listener_unavailable'));
    });
    scheduleReconnect();
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
      void request.catch(onListenerFailure);
    } catch {
      onListenerFailure();
    }
  };

  connect();

  function subscribe(channelId: string): OverlaySubscription | null {
    if (maxInstanceSubscribers !== undefined && totalSubscribers >= maxInstanceSubscribers) return null;
    const current = channelSubscribers.get(channelId) ?? 0;
    if (maxChannelSubscribers !== undefined && current >= maxChannelSubscribers) return null;
    totalSubscribers += 1;
    channelSubscribers.set(channelId, current + 1);
    let released = false;
    return {
      wait(timeoutMs, signal) {
        return new Promise((resolve, reject) => {
          let settled = false;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const waiter: Waiter = {
            resolve: (result) => { if (!settled) { settled = true; resolve(result); } },
            reject: (error) => { if (!settled) { settled = true; reject(error); } },
            finish: () => {
              if (timer) clearTimeout(timer);
              signal?.removeEventListener('abort', onAbort);
              const set = channelWaiters.get(channelId);
              if (set) {
                set.delete(waiter);
                if (set.size === 0) channelWaiters.delete(channelId);
              }
            },
          };
          const onAbort = () => { waiter.finish(); waiter.resolve('timeout'); };
          if (signal?.aborted) { onAbort(); return; }
          signal?.addEventListener('abort', onAbort, { once: true });
          let set = channelWaiters.get(channelId);
          if (!set) { set = new Set(); channelWaiters.set(channelId, set); }
          set.add(waiter);
          timer = setTimeout(() => { waiter.finish(); waiter.resolve('timeout'); }, timeoutMs);
          timer.unref?.();
        });
      },
      release() {
        if (released) return;
        released = true;
        totalSubscribers = Math.max(0, totalSubscribers - 1);
        const count = (channelSubscribers.get(channelId) ?? 1) - 1;
        if (count <= 0) channelSubscribers.delete(channelId);
        else channelSubscribers.set(channelId, count);
      },
    };
  }

  return {
    subscribe,
    health(): OverlayWakeupHealth {
      return { connected, reconnects, failures };
    },
    async close() {
      closed = true;
      connected = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      settleAll((waiter) => {
        waiter.finish();
        waiter.resolve('timeout');
      });
      channelSubscribers.clear();
      totalSubscribers = 0;
      await client.end({ timeout: 5 });
    },
  };
}

export function createDirectOverlayWakeup(
  databaseUrlDirect: string,
  options: WakeupOptions = {},
): OverlayWakeup {
  const sql: Sql = postgres(databaseUrlDirect, { max: 1, prepare: false });
  // RT-02: the notification already carries channelId
  // (app_private.notify_overlay_wakeup, packages/db/migrations/0005). Only
  // that channel's subscribers wake; an unrelated channel's stream never
  // performs a store read for it.
  return createOverlayWakeup(sql, options);
}
