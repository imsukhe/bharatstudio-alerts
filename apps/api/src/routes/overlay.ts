import type { FastifyInstance } from 'fastify';
import type { ApiMetrics } from '../observability/metrics.js';
import { requireAuth, requireAuthAndTerms } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import { composeOverlayEvent, type OverlayEvent, type OverlaySessionRef, type OverlayStore, type RawOverlayEvent } from '../domain/overlay-store.js';
import type { OverlaySubscription, OverlayWakeup } from '../domain/overlay-wakeup.js';
import type { AccountStore } from '../domain/account-store.js';
import { logSafeError } from '../observability/safe-log.js';
import { abortableSleep } from '../domain/abortable-sleep.js';
import { createReplayCoalescer, type ReplayCoalescer } from '../domain/overlay-replay-coalescer.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const channelParams = { type: 'object', additionalProperties: false, required: ['channelId'], properties: { channelId: uuid } } as const;
const overlayParams = { type: 'object', additionalProperties: false, required: ['overlayId'], properties: { overlayId: uuid } } as const;

function unavailable(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string) {
  return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'overlay_store_unavailable', message: 'Overlay sessions are temporarily unavailable', traceId, retryable: true });
}

function admissionLimited(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string) {
  // RT-02 §3.3: a configured, reached ceiling is a clear, retryable
  // rejection — never a silent hang, and always returned BEFORE
  // reply.hijack() so it is a normal JSON error response.
  return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'overlay_admission_limited', message: 'Overlay admission is temporarily limited', traceId, retryable: true });
}

export async function registerOverlayRoutes(app: FastifyInstance, sessions?: SessionStore, store?: OverlayStore, wakeup?: OverlayWakeup, streamOptions: { windowMs: number; pollMs: number; random?: () => number; now?: () => number; sleep?: (timeoutMs: number, signal: AbortSignal) => Promise<void> } = { windowMs: 25_000, pollMs: 2_000 }, account?: AccountStore, appOrigin?: string, metrics?: ApiMetrics): Promise<void> {
  const auth = requireAuth(sessions);
  const termsAuth = requireAuthAndTerms(sessions, account);
  // RT-02 §3.2: one coalescer per running app instance, shared by every SSE
  // connection it serves. Keyed by channelId+cursor+limit so concurrent
  // sessions of the same channel at the same cursor share one store read;
  // different cursors/channels are never coalesced (separate keys).
  const replayCoalescer: ReplayCoalescer<RawOverlayEvent[]> = createReplayCoalescer<RawOverlayEvent[]>();

  async function fetchEvents(token: string, overlayId: string, session: OverlaySessionRef | undefined, cursor: string | undefined, limit: number): Promise<OverlayEvent[] | null> {
    if (session && store?.replayRaw) {
      const key = `${session.channelId}|${cursor ?? ''}|${limit}`;
      const { result, shared } = await replayCoalescer.run(key, () => store.replayRaw!(token, overlayId, cursor, limit));
      metrics?.recordOverlayReplay(shared ? 'shared' : 'leader');
      return result ? result.map((row) => composeOverlayEvent(row, overlayId)) : null;
    }
    // Fallback: no channel context (a store that does not implement
    // resolveSession/replayRaw). Same durable, per-session semantics as
    // before RT-02, without channel-keyed dedup.
    return store!.replay(token, overlayId, cursor, limit);
  }

  app.post<{ Params: { channelId: string } }>('/v1/channels/:channelId/overlay/session', { preHandler: termsAuth, schema: { params: channelParams } }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      return reply.code(201).send(await store.create(request.auth.userId, request.params.channelId));
    } catch (error) {
      logSafeError(request, 'overlay_create_failed', error);
      return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'channel_not_found', message: 'Channel not found', traceId: request.id });
    }
  });

  // Both operations invalidate an existing bearer credential. Do not make a
  // user accept updated legal documents before they can contain a leaked OBS
  // browser-source URL; only creation remains a consent-gated mutation.
  app.delete<{ Params: { overlayId: string } }>('/v1/overlays/:overlayId', { preHandler: auth, schema: { params: overlayParams } }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    const revoked = await store.revoke(request.auth.userId, request.params.overlayId);
    return revoked ? reply.code(204).send() : reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Overlay session not found', traceId: request.id });
  });

  app.post<{ Params: { overlayId: string } }>('/v1/overlays/:overlayId/rotate', { preHandler: auth, schema: { params: overlayParams } }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    const replacement = await store.rotate(request.auth.userId, request.params.overlayId);
    return replacement ? reply.code(201).send(replacement) : reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Overlay session not found', traceId: request.id });
  });

  app.get<{ Params: { overlayId: string }; Querystring: { limit?: number }; Headers: { authorization?: string; 'last-event-id'?: string } }>('/v1/overlays/:overlayId/events', {
    schema: {
      params: overlayParams,
      querystring: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 } } },
      headers: { type: 'object', properties: { authorization: { type: 'string', maxLength: 512 }, 'last-event-id': { type: 'string', maxLength: 256 } } },
    },
  }, async (request, reply) => {
    if (!store) return unavailable(reply, request.id);
    const token = bearerToken(request.headers.authorization);
    if (!token) return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'overlay_unauthorized', message: 'Overlay session is invalid or expired', traceId: request.id });
    const overlayId = request.params.overlayId;

    // RT-02 §3.2(a): resolve this session's own channel before anything
    // else — every session validates its own token on every wake, starting
    // here. A store that does not implement this (test doubles only; the
    // real SQL store always does) opts this connection out of channel-keyed
    // fanout/dedup and falls back to the pre-RT-02 per-session shape below.
    let session: OverlaySessionRef | undefined;
    if (store.resolveSession) {
      try {
        session = (await store.resolveSession(token, overlayId)) ?? undefined;
      } catch (error) {
        logSafeError(request, 'overlay_session_resolve_failed', error);
        return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'overlay_replay_unavailable', message: 'Overlay replay is temporarily unavailable', traceId: request.id, retryable: true });
      }
      if (!session) return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'overlay_unauthorized', message: 'Overlay session is invalid or expired', traceId: request.id });
    }

    // RT-02 §3.3: admission is checked after token validation and before
    // the stream is hijacked. `channelKey` is the resolved channel when
    // available, or the overlayId itself for a store without channel
    // resolution — the same granularity that store already provides.
    const channelKey = session?.channelId ?? overlayId;
    let subscription: OverlaySubscription | null = null;
    if (wakeup) {
      subscription = wakeup.subscribe(channelKey);
      if (!subscription) {
        metrics?.recordOverlayAdmissionRejection();
        return admissionLimited(reply, request.id);
      }
    }
    const release = () => subscription?.release();

    let events;
    try {
      events = await fetchEvents(token, overlayId, session, request.headers['last-event-id'], request.query.limit ?? 50);
      // L09 reconnect-replay: only count a replay the client actually asked to
      // resume (it sent a cursor). A first connection with no Last-Event-Id is
      // not a reconnect, and counting it would inflate the success rate with
      // events that were never at risk of being missed.
      if (request.headers['last-event-id']) metrics?.recordReconnectReplay('success');
    } catch (error) {
      if (request.headers['last-event-id']) metrics?.recordReconnectReplay('failure');
      if (error instanceof Error && error.message === 'invalid_cursor') {
        release();
        return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'bad_cursor', message: 'Overlay cursor is invalid', traceId: request.id });
      }
      logSafeError(request, 'overlay_replay_failed', error);
      release();
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'overlay_replay_unavailable', message: 'Overlay replay is temporarily unavailable', traceId: request.id, retryable: true });
    }
    if (!events) {
      release();
      return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'overlay_unauthorized', message: 'Overlay session is invalid or expired', traceId: request.id });
    }

    reply.hijack();
    // reply.hijack() takes the response fully out of Fastify's own reply
    // pipeline, which is where the globally-registered @fastify/cors
    // plugin's headers actually get flushed (app.ts) — a hijacked SSE
    // response therefore ships with NO CORS headers at all unless they are
    // set explicitly here, which this route never did. In any deployment
    // where the web app and API are on different origins (exactly what
    // config.appOrigin/CORS is already set up to allow), the browser
    // rejects this exact request before a single byte of the stream is
    // read — silently breaking the entire overlay/OBS browser-source
    // delivery path. Caught on a real cross-origin browser run against a
    // live overlay session, not by any inject()-based unit test — inject()
    // never sends a real Origin header the way a browser does. Mirrors the
    // exact single-origin-echo + credentials policy app.ts's own
    // @fastify/cors registration already uses for every other route.
    const requestOrigin = request.headers.origin;
    const corsHeaders: Record<string, string> = { vary: 'Origin' };
    if (appOrigin && requestOrigin === appOrigin) {
      corsHeaders['access-control-allow-origin'] = appOrigin;
      corsHeaders['access-control-allow-credentials'] = 'true';
    }
    reply.raw.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'text/event-stream; charset=utf-8',
      connection: 'keep-alive',
      'x-overlay-stream-version': 'v1',
      ...corsHeaders,
    });
    reply.raw.write(': replay-start\n\n');
    let cursor = request.headers['last-event-id'];
    let closed = false;
    let replayUnavailable = false;
    const disconnect = new AbortController();
    request.raw.on('close', () => {
      closed = true;
      disconnect.abort();
      // RT-02 §3.3: free the admission slot as soon as the client
      // disconnects, not only when the poll loop next notices `closed`.
      // Idempotent — the natural end-of-stream release below is a no-op
      // if this already ran.
      release();
    });
    const writeEvents = (items: NonNullable<typeof events>) => {
      for (const event of items) {
        reply.raw.write(`id: ${event.cursor}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event)}\n\n`);
        cursor = event.cursor;
      }
    };
    writeEvents(events);
    const now = streamOptions.now ?? Date.now;
    const deadline = now() + streamOptions.windowMs;
    while (!closed && now() < deadline) {
      const waitMs = Math.min(streamOptions.pollMs, Math.max(1, deadline - now()));
      let woke = false;
      try {
        if (wakeup && subscription) {
          try {
            woke = (await subscription.wait(waitMs, disconnect.signal)) === 'notification';
          } catch {
            // Listener failure is the sole entry to the bounded fallback.
            const jitterMs = Math.min(waitMs, 500 + Math.floor((streamOptions.random ?? Math.random)() * 1_000));
            await (streamOptions.sleep ?? abortableSleep)(jitterMs, disconnect.signal);
            if (closed) break;
            woke = !disconnect.signal.aborted;
          }
        } else {
          // No listener is configured: treat this as a disconnected wake-up
          // path and use only the bounded jitter fallback.
          const jitterMs = Math.min(waitMs, 500 + Math.floor((streamOptions.random ?? Math.random)() * 1_000));
          await (streamOptions.sleep ?? abortableSleep)(jitterMs, disconnect.signal);
          if (closed) break;
          woke = !disconnect.signal.aborted;
        }
        if (!woke && wakeup?.health().connected) continue;
        if (!woke && wakeup && !wakeup.health().connected) {
          const jitterMs = Math.min(waitMs, 500 + Math.floor((streamOptions.random ?? Math.random)() * 1_000));
          await (streamOptions.sleep ?? abortableSleep)(jitterMs, disconnect.signal);
          if (closed) break;
          woke = !disconnect.signal.aborted;
        }
      } catch (error) {
        logSafeError(request, 'overlay_stream_wait_failed', error);
        replayUnavailable = true;
        break;
      }
      if (closed) break;
      if (!woke) continue;
      try {
        // RT-02 §3.2(a): re-validate this exact session's own token on
        // every wake, before it is given any events — never inherited from
        // whichever session happened to lead a shared replay. A session
        // revoked mid-window stops here, exactly like the `!next` durable
        // check below already stops an unauthorized replay.
        if (store.resolveSession) {
          session = (await store.resolveSession(token, overlayId)) ?? undefined;
          if (!session) break;
        }
        const next = await fetchEvents(token, overlayId, session, cursor, request.query.limit ?? 50);
        if (!next) break;
        writeEvents(next);
      } catch (error) {
        // The stream is already committed, so a transient replay failure
        // cannot become an HTTP 503. Close cleanly; the browser reconnects
        // with its last acknowledged cursor and durable replay remains the
        // source of truth. No event is acknowledged or discarded here.
        logSafeError(request, 'overlay_stream_replay_failed', error);
        replayUnavailable = true;
        break;
      }
    }
    release();
    if (!reply.raw.destroyed && !reply.raw.writableEnded) {
      reply.raw.write(replayUnavailable ? ': replay-unavailable\n\n' : ': replay-complete\n\n');
      reply.raw.end();
    }
  });

  app.post<{ Params: { overlayId: string }; Body: { cursor: string; eventId: string }; Headers: { authorization?: string } }>('/v1/overlays/:overlayId/cursor', {
    schema: {
      params: overlayParams,
      headers: { type: 'object', properties: { authorization: { type: 'string', maxLength: 512 } } },
      body: { type: 'object', additionalProperties: false, required: ['cursor', 'eventId'], properties: { cursor: { type: 'string', minLength: 1, maxLength: 256 }, eventId: uuid } },
    },
  }, async (request, reply) => {
    if (!store) return unavailable(reply, request.id);
    const token = bearerToken(request.headers.authorization);
    if (!token) return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'overlay_unauthorized', message: 'Overlay session is invalid or expired', traceId: request.id });
    try {
      const acknowledged = await store.acknowledge(token, request.params.overlayId, request.body.cursor, request.body.eventId);
      return acknowledged
        ? reply.code(204).send()
        : reply.code(401).send({ schemaVersion: 'v1', errorCode: 'overlay_unauthorized', message: 'Overlay session is invalid or expired', traceId: request.id });
    } catch (error) {
      if (error instanceof Error && error.message === 'invalid_cursor') {
        return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'bad_cursor', message: 'Overlay cursor is invalid', traceId: request.id });
      }
      logSafeError(request, 'overlay_cursor_ack_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'overlay_cursor_unavailable', message: 'Overlay cursor acknowledgement is temporarily unavailable', traceId: request.id, retryable: true });
    }
  });
}

function bearerToken(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^Bearer\s+([^\s]+)$/i.exec(value);
  return match?.[1];
}
