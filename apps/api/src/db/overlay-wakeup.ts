import postgres, { type Sql } from 'postgres';
import type { OverlaySubscription, OverlayWakeup, OverlayWakeupHealth, OverlayWakeupResult } from '../domain/overlay-wakeup.js';

const CHANNEL = 'bharatstudio_overlay_events';
const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

type ListenClient = {
  listen(
    channel: string,
    onnotify: (value: string) => void,
    onlisten?: () => void,
    // The generic seam's existing callers may omit this callback. The direct
    // adapter below supplies it so a socket which drops *after* a successful
    // LISTEN cannot remain represented as healthy.
    onclose?: () => void,
  ): Promise<unknown>;
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

  // A failed request and a close event can describe the same attempt. Keep an
  // attempt identity so either path settles waiters/schedules at most once,
  // and so an old socket cannot change the health of its replacement.
  let activeAttempt = 0;

  const onListenerFailure = (attempt: number) => {
    if (attempt !== activeAttempt) return;
    if (closed) return;
    activeAttempt += 1;
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
    const attempt = activeAttempt + 1;
    activeAttempt = attempt;
    connected = false;
    try {
      const onRegistered = () => {
        if (closed || attempt !== activeAttempt) return;
        connected = true;
        delay = reconnectDelayMs;
      };
      const onClosed = () => onListenerFailure(attempt);
      const request = client.listen(CHANNEL, notify, onRegistered, onClosed);
      // A registration rejection and post-registration close share the same
      // attempt guard above. The direct adapter makes both observable; test
      // doubles that expose only a rejected request retain the old behavior.
      void request.catch(onClosed);
    } catch {
      onListenerFailure(attempt);
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
  // postgres.js's public sql.listen() intentionally owns a private listener
  // connection and re-registers it after a close. That convenience behaviour
  // is useful generally, but it gives this API no close signal: health could
  // remain true during a post-registration outage. This adapter owns exactly
  // one explicit `LISTEN` connection instead. postgres 3.4.9 invokes these
  // connection callbacks on the dedicated socket; package/version evidence is
  // exercised by integration/overlay-wakeup.integration.ts.
  //
  // onnotify is implemented by the installed postgres runtime but omitted
  // from its TypeScript declaration. Constrain its use to this adapter and
  // keep the cast local; the integration test sends a real pg_notify through
  // this path so a package upgrade cannot silently preserve a fake unit test.
  type RuntimeListenerOptions = {
    max: number;
    prepare: boolean;
    idle_timeout: null;
    max_lifetime: null;
    fetch_types: boolean;
    connection: { application_name: string };
    onclose: () => void;
    onnotify: (channel: string, payload: string) => void;
  };
  type RuntimePostgresFactory = (url: string, options: RuntimeListenerOptions) => Sql;
  const createRuntimeListener = postgres as unknown as RuntimePostgresFactory;
  let activeListener: Sql | undefined;

  const directClient: ListenClient = {
    async listen(channel, onnotify, onlisten, onclose) {
      // The only caller is this module's constant. Refuse a widened future
      // call rather than turn a query identifier into a hidden input surface.
      if (channel !== CHANNEL) throw new Error('unexpected_overlay_notification_channel');

      let listener: Sql;
      listener = createRuntimeListener(databaseUrlDirect, {
        max: 1,
        prepare: false,
        idle_timeout: null,
        max_lifetime: null,
        fetch_types: false,
        connection: { application_name: 'bharatstudio-alerts-overlay-wakeup' },
        onclose: () => {
          if (activeListener === listener) activeListener = undefined;
          onclose?.();
        },
        onnotify: (receivedChannel, payload) => {
          if (receivedChannel === CHANNEL) onnotify(payload);
        },
      });
      activeListener = listener;

      try {
        // CHANNEL is fixed and validated above. It contains no user/config
        // value; quote the identifier from that sole constant so a future
        // constant edit cannot make the guard and executed command diverge.
        await listener.unsafe(`listen "${CHANNEL.replace(/"/g, '""')}"`);
        onlisten?.();
      } catch (error) {
        if (activeListener === listener) activeListener = undefined;
        await listener.end({ timeout: 5 }).catch(() => undefined);
        throw error;
      }
    },
    async end(options) {
      const listener = activeListener;
      activeListener = undefined;
      if (listener) await listener.end(options);
    },
  };

  // RT-02: the notification already carries channelId
  // (app_private.notify_overlay_wakeup, packages/db/migrations/0005). Only
  // that channel's subscribers wake; an unrelated channel's stream never
  // performs a store read for it.
  return createOverlayWakeup(directClient, options);
}
