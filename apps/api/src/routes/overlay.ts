import type { FastifyInstance } from 'fastify';
import { requireAuth, requireAuthAndTerms } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import type { OverlayStore } from '../domain/overlay-store.js';
import type { OverlayWakeup } from '../domain/overlay-wakeup.js';
import type { AccountStore } from '../domain/account-store.js';
import { logSafeError } from '../observability/safe-log.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const channelParams = { type: 'object', additionalProperties: false, required: ['channelId'], properties: { channelId: uuid } } as const;
const overlayParams = { type: 'object', additionalProperties: false, required: ['overlayId'], properties: { overlayId: uuid } } as const;

function unavailable(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string) {
  return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'overlay_store_unavailable', message: 'Overlay sessions are temporarily unavailable', traceId, retryable: true });
}

export async function registerOverlayRoutes(app: FastifyInstance, sessions?: SessionStore, store?: OverlayStore, wakeup?: OverlayWakeup, streamOptions: { windowMs: number; pollMs: number } = { windowMs: 25_000, pollMs: 2_000 }, account?: AccountStore, appOrigin?: string): Promise<void> {
  const auth = requireAuth(sessions);
  const termsAuth = requireAuthAndTerms(sessions, account);

  app.post<{ Params: { channelId: string } }>('/v1/channels/:channelId/overlay/session', { preHandler: termsAuth, schema: { params: channelParams } }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      return reply.code(201).send(await store.create(request.auth.userId, request.params.channelId));
    } catch (error) {
      logSafeError(request, 'overlay_create_failed', error);
      return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'channel_not_found', message: 'Channel not found', traceId: request.id });
    }
  });

  app.delete<{ Params: { overlayId: string } }>('/v1/overlays/:overlayId', { preHandler: termsAuth, schema: { params: overlayParams } }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    const revoked = await store.revoke(request.auth.userId, request.params.overlayId);
    return revoked ? reply.code(204).send() : reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Overlay session not found', traceId: request.id });
  });

  app.post<{ Params: { overlayId: string } }>('/v1/overlays/:overlayId/rotate', { preHandler: termsAuth, schema: { params: overlayParams } }, async (request, reply) => {
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
    let events;
    try {
      events = await store.replay(token, request.params.overlayId, request.headers['last-event-id'], request.query.limit ?? 50);
    } catch (error) {
      if (error instanceof Error && error.message === 'invalid_cursor') {
        return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'bad_cursor', message: 'Overlay cursor is invalid', traceId: request.id });
      }
      logSafeError(request, 'overlay_replay_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'overlay_replay_unavailable', message: 'Overlay replay is temporarily unavailable', traceId: request.id, retryable: true });
    }
    if (!events) return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'overlay_unauthorized', message: 'Overlay session is invalid or expired', traceId: request.id });

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
    });
    const writeEvents = (items: NonNullable<typeof events>) => {
      for (const event of items) {
        reply.raw.write(`id: ${event.cursor}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event)}\n\n`);
        cursor = event.cursor;
      }
    };
    writeEvents(events);
    const deadline = Date.now() + streamOptions.windowMs;
    while (!closed && Date.now() < deadline) {
      const waitMs = Math.min(streamOptions.pollMs, Math.max(1, deadline - Date.now()));
      try {
        if (wakeup) await wakeup.wait(request.params.overlayId, waitMs, disconnect.signal);
        else await waitWithAbort(waitMs, disconnect.signal);
      } catch (error) {
        logSafeError(request, 'overlay_stream_wait_failed', error);
        replayUnavailable = true;
        break;
      }
      if (closed) break;
      try {
        const next = await store.replay(token, request.params.overlayId, cursor, request.query.limit ?? 50);
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

function waitWithAbort(timeoutMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    if (signal.aborted) {
      finish();
      return;
    }
    signal.addEventListener('abort', finish, { once: true });
    timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
  });
}

function bearerToken(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^Bearer\s+([^\s]+)$/i.exec(value);
  return match?.[1];
}
