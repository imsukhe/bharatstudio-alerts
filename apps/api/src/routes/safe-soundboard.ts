import type { FastifyInstance } from 'fastify';
import { requireAuth, requireAuthAndTerms } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import type { AccountStore } from '../domain/account-store.js';
import type { SafeSoundboardStore } from '../domain/safe-soundboard-store.js';
import { logSafeError } from '../observability/safe-log.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const channelParams = { type: 'object', additionalProperties: false, required: ['channelId'], properties: { channelId: uuid } } as const;
const catalogueEntryParams = {
  type: 'object', additionalProperties: false, required: ['channelId', 'entryId'],
  properties: { channelId: uuid, entryId: uuid },
} as const;

const toggleBody = {
  type: 'object', additionalProperties: false, required: ['enabled'],
  properties: { enabled: { type: 'boolean' } },
} as const;

// `additionalProperties: false` is LOAD-BEARING, not boilerplate -- it is
// where the 2026-09-17 decision's prohibitions are enforced on the wire.
// NO REVIEW/STATUS FIELD. `status`, `moderationState`, `approved`,
// `reviewed` and `reviewedAt` are all 400s: there is no state between
// "uploaded" and "playable" for a client to set. NO CAP FIELD. A client
// cannot send its own duration/size cap -- the server's configured
// (today: unset) caps are the only ones that apply, read from server
// config in the route handler below, never from the request body.
const uploadBody = {
  type: 'object', additionalProperties: false,
  required: ['displayName', 'contentSha256', 'mimeType', 'byteSize', 'durationSeconds', 'rightsAttested'],
  properties: {
    displayName: { type: 'string', minLength: 1, maxLength: 120 },
    contentSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    mimeType: { type: 'string', pattern: '^audio/[a-z0-9.+-]+$', maxLength: 100 },
    // PostgreSQL `integer`'s own range -- a storage bound, not a product
    // one. The real, currently-unset cap is enforced in SQL (0143),
    // which is the only place that can compare against server config.
    byteSize: { type: 'integer', minimum: 1, maximum: 2147483647 },
    durationSeconds: { type: 'integer', minimum: 1, maximum: 2147483647 },
    // AUD-06 / §18.2: a positive attestation, recorded with a timestamp
    // in SQL. `false` is a valid, explicit request the server refuses --
    // never silently coerced to true.
    rightsAttested: { type: 'boolean' },
  },
} as const;

// Exactly one of catalogueEntryId / uploadId -- enforced twice: here by
// oneOf, and again in SQL (0143's trigger_soundboard_play), which is the
// authority the SQL test proves against.
const triggerPlayBody = {
  type: 'object',
  oneOf: [
    { type: 'object', additionalProperties: false, required: ['catalogueEntryId'], properties: { catalogueEntryId: uuid } },
    { type: 'object', additionalProperties: false, required: ['uploadId'], properties: { uploadId: uuid } },
  ],
} as const;

function unavailable(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string) {
  return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'safe_soundboard_store_unavailable', message: 'The soundboard is temporarily unavailable', traceId, retryable: true });
}

export type SafeSoundboardUploadCaps = {
  maxDurationSeconds?: number;
  maxByteSize?: number;
};

// PRF-02 slice 7, §6 catalogue module #6 (Safe Soundboard Alert): the
// creator's own catalogue management, uploads and trigger.
//
// Authority: FULL-PRODUCT-DEFINITION.md §6 module #6, §12.6, §18, §19.1,
// §30.3, AUD-06, and bharatstudio-requirements/reviews/
// 2026-09-17-remaining-eight-modules-and-youtube-v1-amendment.md Part 1
// §1. Task record: bharatstudio-requirements/active/tasks/
// PRF-02-slice-7-safe-soundboard.md.
//
// ITS OWN FILE, for the same reason routes/giveaway-tournament.ts and
// routes/lobby-session.ts are: routes/master-canvas.ts (which owns the
// module #6 OVERLAY read) already takes many positional dependencies,
// and these are creator writes rather than canvas rendering.
//
// NEVER TIER-GATED (§12.6): every route here is available at every tier.
// The §30.3 Pro+ module-render gate and the per-tier upload-count ladder
// both live in SQL, not here.
//
// A NON-OWNER/ADMIN GETS 404, NEVER 403, on the catalogue toggle and the
// upload/trigger routes -- existence of a channel the caller may not see
// is itself information, matching giveaway-tournament.ts and
// lobby-session.ts.
export async function registerSafeSoundboardRoutes(
  app: FastifyInstance,
  sessions?: SessionStore,
  store?: SafeSoundboardStore,
  account?: AccountStore,
  uploadCaps: SafeSoundboardUploadCaps = {},
): Promise<void> {
  const auth = requireAuth(sessions);
  const termsAuth = requireAuthAndTerms(sessions, account);

  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/soundboard/catalogue', {
    preHandler: auth,
    schema: { params: channelParams },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const entries = await store.listCatalogue(request.auth.userId, request.params.channelId);
      return reply.code(200).send({ schemaVersion: 'v1', entries });
    } catch (error) {
      logSafeError(request, 'soundboard_catalogue_read_failed', error);
      return unavailable(reply, request.id);
    }
  });

  app.put<{ Params: { channelId: string; entryId: string }; Body: { enabled: boolean } }>('/v1/channels/:channelId/soundboard/catalogue/:entryId', {
    preHandler: termsAuth,
    schema: { params: catalogueEntryParams, body: toggleBody },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await store.setCatalogueEntryEnabled(
        request.auth.userId, request.params.channelId, request.params.entryId, request.body.enabled,
      );
      switch (result.outcome) {
        case 'ok': return reply.code(200).send({ schemaVersion: 'v1', entries: result.entries });
        case 'forbidden': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Channel not found', traceId: request.id });
        case 'invalid': return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_soundboard_entry', message: 'Unknown catalogue entry', traceId: request.id });
      }
    } catch (error) {
      logSafeError(request, 'soundboard_catalogue_toggle_failed', error);
      return unavailable(reply, request.id);
    }
  });

  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/soundboard/uploads', {
    preHandler: auth,
    schema: { params: channelParams },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const uploads = await store.listUploads(request.auth.userId, request.params.channelId);
      return reply.code(200).send({ schemaVersion: 'v1', uploads });
    } catch (error) {
      logSafeError(request, 'soundboard_uploads_read_failed', error);
      return unavailable(reply, request.id);
    }
  });

  // NO REVIEW STEP (2026-09-17 decision): a successful 201 here means the
  // clip is immediately triggerable. See uploadBody's own header for why
  // there is no status/moderation field to set instead.
  //
  // THE CAPS COME FROM SERVER CONFIG, READ HERE, NEVER FROM THE REQUEST.
  // `uploadCaps` is threaded in from apps/api/src/index.ts, itself
  // sourced from config.ts's `optionalPositiveInt`-parsed env vars --
  // unset (the value in every environment today) means every upload is
  // refused with `caps_not_configured`, regardless of the clip. Unset
  // never means unlimited.
  app.post<{ Params: { channelId: string }; Body: { displayName: string; contentSha256: string; mimeType: string; byteSize: number; durationSeconds: number; rightsAttested: boolean } }>('/v1/channels/:channelId/soundboard/uploads', {
    preHandler: termsAuth,
    schema: { params: channelParams, body: uploadBody },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await store.uploadClip(
        request.auth.userId, request.params.channelId,
        {
          displayName: request.body.displayName,
          contentSha256: request.body.contentSha256,
          mimeType: request.body.mimeType,
          byteSize: request.body.byteSize,
          durationSeconds: request.body.durationSeconds,
          rightsAttested: request.body.rightsAttested,
        },
        uploadCaps,
      );
      switch (result.outcome) {
        case 'ok': return reply.code(201).send({ schemaVersion: 'v1', upload: result.upload });
        case 'forbidden': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Channel not found', traceId: request.id });
        // The mechanism exists and reads its cap from config; with no
        // value configured, the upload control is inert -- see 0143's
        // header. Never a 200, never treated as "no limit".
        case 'caps_not_configured': return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'soundboard_uploads_not_configured', message: 'Soundboard uploads are not yet configured for this deployment', traceId: request.id });
        case 'rights_not_attested': return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'rights_attestation_required', message: 'A rights attestation is required to upload a soundboard clip', traceId: request.id });
        case 'cap_exceeded': return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'soundboard_clip_too_large', message: 'The clip exceeds the configured duration or size cap', traceId: request.id });
        case 'tier_limit_reached': return reply.code(403).send({ schemaVersion: 'v1', errorCode: 'soundboard_upload_limit_reached', message: "This channel has reached its tier's soundboard upload count limit", traceId: request.id });
        case 'conflict': return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'soundboard_clip_already_uploaded', message: 'An identical clip has already been uploaded to this channel', traceId: request.id });
        case 'invalid': return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_soundboard_upload', message: 'The clip could not be uploaded', traceId: request.id });
      }
    } catch (error) {
      logSafeError(request, 'soundboard_upload_failed', error);
      return unavailable(reply, request.id);
    }
  });

  // The creator's own trigger. NO SUPPORTER PATH -- see 0143's header:
  // AUD-03 (supporter-triggerable) is a separate, not-yet-authorised
  // decision. NO COOLDOWN is applied -- none is decided anywhere in this
  // repository.
  app.post<{ Params: { channelId: string }; Body: { catalogueEntryId?: string; uploadId?: string } }>('/v1/channels/:channelId/soundboard/play', {
    preHandler: termsAuth,
    schema: { params: channelParams, body: triggerPlayBody },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const source = request.body.catalogueEntryId
        ? { catalogueEntryId: request.body.catalogueEntryId } as const
        : { uploadId: request.body.uploadId as string } as const;
      const result = await store.triggerPlay(request.auth.userId, request.params.channelId, source);
      switch (result.outcome) {
        case 'ok': return reply.code(201).send({ schemaVersion: 'v1', playId: result.playId });
        case 'forbidden': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Channel not found', traceId: request.id });
        case 'not_found': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Unknown soundboard clip', traceId: request.id });
        case 'invalid': return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_soundboard_trigger', message: 'That clip could not be triggered', traceId: request.id });
      }
    } catch (error) {
      logSafeError(request, 'soundboard_trigger_failed', error);
      return unavailable(reply, request.id);
    }
  });
}
