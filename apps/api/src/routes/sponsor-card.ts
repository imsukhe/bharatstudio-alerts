import type { FastifyInstance } from 'fastify';
import { requireAuth, requireAuthAndTerms } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import type { AccountStore } from '../domain/account-store.js';
import {
  SPONSOR_LOGO_MIME_TYPE_MAX_LENGTH,
  SPONSOR_LOGO_MIME_TYPE_MIN_LENGTH,
  SPONSOR_NAME_MAX_LENGTH,
  SPONSOR_NAME_MIN_LENGTH,
  type SponsorCardStore,
} from '../domain/sponsor-card-store.js';
import { logSafeError } from '../observability/safe-log.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const channelParams = { type: 'object', additionalProperties: false, required: ['channelId'], properties: { channelId: uuid } } as const;

// `additionalProperties: false` is LOAD-BEARING here, not boilerplate. It
// is where the 2026-09-17 decision is enforced on the wire: a body
// carrying `impressionCount`, `exposureCount`, `views`, `shownAt`,
// `displayedAt` or `duration` is a 400 before the store is ever called --
// the card renders the sponsor and counts nothing, and there is no field
// here for a client to even ATTEMPT to write one into.
const upsertBody = {
  type: 'object', additionalProperties: false,
  required: ['sponsorName', 'enabled', 'logoContentSha256', 'logoMimeType', 'logoByteSize', 'scheduleStartsAt', 'scheduleEndsAt'],
  properties: {
    sponsorName: { type: 'string', minLength: SPONSOR_NAME_MIN_LENGTH, maxLength: SPONSOR_NAME_MAX_LENGTH },
    enabled: { type: 'boolean' },
    // All three null together or set together -- re-checked in the SQL
    // function (migration 0145) and in the domain layer
    // (isValidLogoTriple); the schema only bounds the SHAPE of each field
    // when present.
    logoContentSha256: { type: ['string', 'null'], pattern: '^[0-9a-f]{64}$' },
    logoMimeType: { type: ['string', 'null'], minLength: SPONSOR_LOGO_MIME_TYPE_MIN_LENGTH, maxLength: SPONSOR_LOGO_MIME_TYPE_MAX_LENGTH },
    logoByteSize: { type: ['integer', 'null'], minimum: 1 },
    // An instruction about the FUTURE, never a record of the past. Both
    // null (no schedule) or both set -- re-checked in the SQL function.
    scheduleStartsAt: { type: ['string', 'null'], format: 'date-time' },
    scheduleEndsAt: { type: ['string', 'null'], format: 'date-time' },
  },
} as const;

type UpsertSponsorCardBody = {
  sponsorName: string;
  enabled: boolean;
  logoContentSha256: string | null;
  logoMimeType: string | null;
  logoByteSize: number | null;
  scheduleStartsAt: string | null;
  scheduleEndsAt: string | null;
};

function unavailable(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string) {
  return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'sponsor_card_store_unavailable', message: 'The sponsor card is temporarily unavailable', traceId, retryable: true });
}

// PRF-02 slice 7: §6 catalogue module #11, Sponsor Card. Creator-facing
// reads and writes only -- the overlay read lives in
// routes/master-canvas.ts alongside every other Master Canvas module's
// overlay read, exactly the same split stream-mission.ts and
// giveaway-tournament.ts use.
//
// NEVER TIER-GATED (§12.6). Storing, viewing and changing a durable
// creator record is available at every tier. `sponsor_card` is already
// one of migration 0131's twenty catalogue keys, and the §30.3
// module-count cap it enforces is the only thing that decides whether the
// CANVAS renders this card -- there is no tier check anywhere in this
// file.
//
// ONE UPSERT, NOT A LIFECYCLE. Unlike the Stream Mission or
// Giveaway/Tournament cards, there is no start/end/close verb here: PUT
// always writes the channel's one sponsor card, and disabling it is
// `enabled: false` on the same call.
//
// A NON-OWNER/ADMIN GETS 404, NEVER 403 -- the same non-leaking mapping
// master-canvas.ts, lobby-session.ts, stream-mission.ts and
// giveaway-tournament.ts already use.
export async function registerSponsorCardRoutes(
  app: FastifyInstance,
  sessions?: SessionStore,
  store?: SponsorCardStore,
  account?: AccountStore,
): Promise<void> {
  const auth = requireAuth(sessions);
  const termsAuth = requireAuthAndTerms(sessions, account);

  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/sponsor-card', {
    preHandler: auth,
    schema: { params: channelParams },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const sponsorCard = await store.getCurrent(request.auth.userId, request.params.channelId);
      return reply.code(200).send({ schemaVersion: 'v1', sponsorCard });
    } catch (error) {
      logSafeError(request, 'sponsor_card_read_failed', error);
      return unavailable(reply, request.id);
    }
  });

  app.put<{ Params: { channelId: string }; Body: UpsertSponsorCardBody }>('/v1/channels/:channelId/sponsor-card', {
    preHandler: termsAuth,
    schema: { params: channelParams, body: upsertBody },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await store.upsert(request.auth.userId, request.params.channelId, {
        sponsorName: request.body.sponsorName,
        logoContentSha256: request.body.logoContentSha256,
        logoMimeType: request.body.logoMimeType,
        logoByteSize: request.body.logoByteSize,
        enabled: request.body.enabled,
        scheduleStartsAt: request.body.scheduleStartsAt,
        scheduleEndsAt: request.body.scheduleEndsAt,
      });
      switch (result.outcome) {
        case 'ok': return reply.code(200).send({ schemaVersion: 'v1', sponsorCard: result.sponsorCard });
        case 'forbidden': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Channel not found', traceId: request.id });
        case 'invalid': return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_sponsor_card', message: 'The sponsor card could not be saved', traceId: request.id });
      }
    } catch (error) {
      logSafeError(request, 'sponsor_card_upsert_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'sponsor_card_store_unavailable', message: 'The sponsor card could not be saved', traceId: request.id, retryable: true });
    }
  });
}
