import type { FastifyInstance } from 'fastify';
import { requireAuth, requireAuthAndTerms } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import type { AccountStore } from '../domain/account-store.js';
import {
  MEDIA_QUEUE_DURATION_MAX_MS,
  MEDIA_QUEUE_KINDS,
  MEDIA_QUEUE_MIME_TYPES,
  MEDIA_QUEUE_OBJECT_KEY_MAX,
  MEDIA_QUEUE_OBJECT_KEY_PATTERN,
  MEDIA_QUEUE_TITLE_MAX,
  type MediaQueueStore,
} from '../domain/media-queue-store.js';
import { logSafeError } from '../observability/safe-log.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const channelParams = { type: 'object', additionalProperties: false, required: ['channelId'], properties: { channelId: uuid } } as const;
const itemParams = {
  type: 'object', additionalProperties: false, required: ['channelId', 'itemId'],
  properties: { channelId: uuid, itemId: uuid },
} as const;
const listQuerystring = {
  type: 'object', additionalProperties: false,
  properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } },
} as const;

// Migration 0143's gcs_object_key character-set shape, mirrored exactly
// (migration 0148), PLUS a negative lookahead forbidding ".." -- a key
// fragment matching this pattern cannot carry a scheme, a host or a
// traversal segment. This is the wire-level half of the fix for the
// "arbitrary remote origin" finding: an AJV `pattern` mismatch (any URL,
// since ':' and '//' are outside the allowed character set) is a 400
// here, before the SQL layer's own identical CHECK constraint is ever
// reached.
const objectKeyPattern = `^(?!.*\\.\\.)${MEDIA_QUEUE_OBJECT_KEY_PATTERN.source.slice(1)}`;

// `additionalProperties: false` on every body below is LOAD-BEARING, not
// boilerplate. It is where the owner's 2026-09-17 "creator-only, viewers
// cannot submit" decision is enforced on the wire: a body carrying
// `submitterId`, `submittedBy`, `viewerId`, `approved`, `approvalStatus`
// or `rejectionReason` is a 400 before the store is ever called, because
// none of those fields is declared here for AJV to accept.
const enqueueBody = {
  type: 'object', additionalProperties: false,
  required: ['title', 'mediaKind', 'mimeType', 'gcsObjectKey'],
  properties: {
    title: { type: 'string', minLength: 1, maxLength: MEDIA_QUEUE_TITLE_MAX },
    mediaKind: { type: 'string', enum: [...MEDIA_QUEUE_KINDS] },
    // §9.1.1 closed allow-list -- no text/html, no image/svg+xml, no
    // application/* of any kind. A client cannot widen this: an
    // unrecognised mime type is a 400 here, before the SQL layer's own
    // identical CHECK constraint is ever reached.
    mimeType: { type: 'string', enum: [...MEDIA_QUEUE_MIME_TYPES] },
    // §19.1 / §9.1.1 (migration 0148): a content-KEY fragment, never a
    // URL. This is what makes it structurally impossible for a caller to
    // point the Master Canvas at an arbitrary third-party origin -- the
    // allowed character set has no slot for a scheme or a host.
    gcsObjectKey: { type: 'string', minLength: 1, maxLength: MEDIA_QUEUE_OBJECT_KEY_MAX, pattern: objectKeyPattern },
    thumbnailGcsObjectKey: { type: 'string', minLength: 1, maxLength: MEDIA_QUEUE_OBJECT_KEY_MAX, pattern: objectKeyPattern },
    durationMs: { type: 'integer', minimum: 0, maximum: MEDIA_QUEUE_DURATION_MAX_MS },
  },
} as const;

const updateBody = {
  type: 'object', additionalProperties: false, required: ['title', 'enabled'],
  properties: {
    title: { type: 'string', minLength: 1, maxLength: MEDIA_QUEUE_TITLE_MAX },
    enabled: { type: 'boolean' },
  },
} as const;

const statusBody = {
  type: 'object', additionalProperties: false, required: ['status'],
  properties: {
    // PLAYBACK lifecycle only -- never 'approved', 'rejected' or any
    // moderation-shaped value. See migration 0146's header.
    status: { type: 'string', enum: ['queued', 'played', 'skipped'] },
  },
} as const;

function unavailable(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string) {
  return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'media_queue_store_unavailable', message: 'The media queue is temporarily unavailable', traceId, retryable: true });
}

// PRF-02 slice 7, §6 catalogue module #20: the creator's own reads and
// writes of their media queue.
//
// Authority: FULL-PRODUCT-DEFINITION.md §6 module #20, §9.1.1, §12.6,
// §19.1, MED-20, MED-21, and bharatstudio-requirements/reviews/
// 2026-09-17-remaining-eight-modules-and-youtube-v1-amendment.md, Part 1
// §8. Task record: bharatstudio-requirements/active/tasks/
// PRF-02-slice-7-media-queue.md.
//
// ITS OWN FILE, for the same reason routes/giveaway-tournament.ts and
// routes/lobby-session.ts are: routes/master-canvas.ts (which owns the
// module #20 OVERLAY read) already takes many positional dependencies,
// and these are creator writes rather than canvas rendering.
//
// THIS IS THE ONLY WRITE SURFACE IN THE ENTIRE PRODUCT FOR
// media_queue_items. There is no submission route, no approval route and
// no viewer-facing route anywhere else that can reach this table --
// grep the diff for 'submit', 'submission', 'submitter', 'viewer_id',
// 'approve', 'approval' and 'reject' to confirm none of them appears in
// this file, and see migration 0146's own structural SQL test
// (MED20.1) for the guarantee that holds even if a future edit tries.
//
// NEVER TIER-GATED (§12.6). There is no tier check anywhere in this file.
// What §30.3-style module caps decide is whether the CANVAS renders the
// module, which is 0131's existing, untouched, module-wide cap.
//
// THE ONLY GATE HERE IS THE ROLE GATE, and it lives in SQL:
// app_private.has_channel_role(channel, ['owner','admin']) inside
// migration 0146's own functions.
//
// A NON-OWNER/ADMIN GETS 404, NEVER 403, for the identical reason
// master-canvas.ts, lobby-session.ts and giveaway-tournament.ts already
// answer this way: existence of a channel the caller may not see is
// itself information.
export async function registerMediaQueueRoutes(
  app: FastifyInstance,
  sessions?: SessionStore,
  store?: MediaQueueStore,
  account?: AccountStore,
  // CONFIGURED BUT UNSET (see migration 0146's header and
  // apps/api/src/config.ts). Neither value is chosen by this codebase;
  // both default to undefined, which means no additional ceiling beyond
  // what already exists structurally.
  maxItemDurationMs?: number,
  maxQueueItemsPerChannel?: number,
): Promise<void> {
  const auth = requireAuth(sessions);
  const termsAuth = requireAuthAndTerms(sessions, account);

  app.get<{ Params: { channelId: string }; Querystring: { limit?: number } }>('/v1/channels/:channelId/media-queue', {
    preHandler: auth,
    schema: { params: channelParams, querystring: listQuerystring },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const items = await store.listItems(request.auth.userId, request.params.channelId, request.query.limit);
      return reply.code(200).send({ schemaVersion: 'v1', items });
    } catch (error) {
      logSafeError(request, 'media_queue_list_failed', error);
      return unavailable(reply, request.id);
    }
  });

  app.post<{
    Params: { channelId: string };
    Body: { title: string; mediaKind: string; mimeType: string; gcsObjectKey: string; thumbnailGcsObjectKey?: string; durationMs?: number };
  }>('/v1/channels/:channelId/media-queue', {
    preHandler: termsAuth,
    schema: { params: channelParams, body: enqueueBody },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await store.enqueueItem(request.auth.userId, request.params.channelId, {
        title: request.body.title,
        mediaKind: request.body.mediaKind as 'image' | 'gif' | 'video',
        mimeType: request.body.mimeType as (typeof MEDIA_QUEUE_MIME_TYPES)[number],
        gcsObjectKey: request.body.gcsObjectKey,
        thumbnailGcsObjectKey: request.body.thumbnailGcsObjectKey ?? null,
        durationMs: request.body.durationMs ?? null,
        maxDurationMs: maxItemDurationMs ?? null,
        maxQueueItems: maxQueueItemsPerChannel ?? null,
      });
      switch (result.outcome) {
        case 'ok': return reply.code(201).send({ schemaVersion: 'v1', item: result.item });
        case 'forbidden': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Channel not found', traceId: request.id });
        case 'invalid': return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_media_queue_item', message: 'The media item could not be queued', traceId: request.id });
        case 'limit_reached': return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'media_queue_limit_reached', message: 'The media queue is at its configured limit', traceId: request.id });
      }
    } catch (error) {
      logSafeError(request, 'media_queue_enqueue_failed', error);
      return unavailable(reply, request.id);
    }
  });

  app.patch<{ Params: { channelId: string; itemId: string }; Body: { title: string; enabled: boolean } }>('/v1/channels/:channelId/media-queue/:itemId', {
    preHandler: termsAuth,
    schema: { params: itemParams, body: updateBody },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await store.updateItem(request.auth.userId, request.params.channelId, request.params.itemId, request.body.title, request.body.enabled);
      switch (result.outcome) {
        case 'ok': return reply.code(200).send({ schemaVersion: 'v1', item: result.item });
        case 'not_found': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Media queue item not found', traceId: request.id });
        case 'invalid': return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_media_queue_item', message: 'The media item could not be updated', traceId: request.id });
      }
    } catch (error) {
      logSafeError(request, 'media_queue_update_failed', error);
      return unavailable(reply, request.id);
    }
  });

  // PLAYBACK lifecycle only. Marking an item played or skipped does not
  // delete it (§12.6) -- it stops appearing in the overlay's live
  // rotation and stays in the creator's own durable list forever.
  app.patch<{ Params: { channelId: string; itemId: string }; Body: { status: 'queued' | 'played' | 'skipped' } }>('/v1/channels/:channelId/media-queue/:itemId/status', {
    preHandler: termsAuth,
    schema: { params: itemParams, body: statusBody },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await store.setItemStatus(request.auth.userId, request.params.channelId, request.params.itemId, request.body.status);
      switch (result.outcome) {
        case 'ok': return reply.code(200).send({ schemaVersion: 'v1', item: result.item });
        case 'not_found': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Media queue item not found', traceId: request.id });
        case 'invalid': return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_media_queue_item_status', message: 'That status could not be recorded', traceId: request.id });
      }
    } catch (error) {
      logSafeError(request, 'media_queue_status_failed', error);
      return unavailable(reply, request.id);
    }
  });
}
