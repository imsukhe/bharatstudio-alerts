import type { FastifyInstance } from 'fastify';
import type { PublicChannelRepository } from '../domain/public-channel.js';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { PaymentOrderService } from '../domain/payment-order.js';
import type { PublicPaymentStatusRepository } from '../domain/public-payment-status.js';
import { logSafeError } from '../observability/safe-log.js';
import type { PublicAbuseGuard } from '../domain/public-abuse.js';
import type { TipIntentRepository } from '../domain/tipintent-types.js';
import { TIPINTENT_TOKEN_PATTERN } from '../db/tipintent-store.js';
// L16 gap closure (0108): let a tip carry a paid-vote option tag. See the
// call site below for why a tagging failure never fails the underlying
// checkout.
import type { VotePaymentTagStore } from '../domain/vote-payment-types.js';

const handlePattern = '^[A-Za-z0-9._-]+$';
const idempotencyKeyPattern = '^[A-Za-z0-9._:-]+$';

// Constant-time comparison so a mistimed response can never help a caller
// narrow down the internal creation secret one byte at a time.
function secretsMatch(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(providedBuffer, expectedBuffer);
}

export async function registerPublicRoutes(
  app: FastifyInstance,
  repository?: PublicChannelRepository,
  paymentOrders?: PaymentOrderService,
  paymentEnvironment: 'test' | 'live' = 'test',
  paymentStatus?: PublicPaymentStatusRepository,
  abuseGuard?: PublicAbuseGuard,
  turnstileRequired = false,
  // TipIntent additions (L15 task 7/8/17 — 10.3 item 17). All optional and
  // appended at the end so every existing positional call (app.ts) keeps
  // compiling and behaving unchanged; when tipIntents is undefined the new
  // routes below fail closed to 503, exactly like the other optional
  // dependencies in this file.
  tipIntents?: TipIntentRepository,
  // Shared secret for the internal (poller-facing) creation route — NOT a
  // per-user credential, since the caller is a service, not a browser
  // session. Constant-time compared via secretsMatch above.
  tipIntentCreationSecret?: string,
  // Origin the opaque short link is built against, e.g.
  // "https://app.bharatstudio.com" — deliberately configurable rather than
  // hardcoded so staging/production/test never share a link namespace.
  tipIntentShortLinkOrigin = 'https://app.bharatstudio.com',
  // L16 gap closure (0108): optional for isolated route tests. Production
  // supplies it from buildApp/index whenever a SQL client is configured.
  // A tip itself must still succeed if the tag is invalid or unavailable.
  votePaymentTags?: VotePaymentTagStore,
): Promise<void> {
  app.get<{ Params: { handle: string } }>(
    '/v1/public/channels/:handle',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['handle'],
          properties: {
            handle: { type: 'string', minLength: 1, maxLength: 64, pattern: handlePattern },
          },
        },
      },
    },
    async (request, reply) => {
      if (!repository) {
        return reply.code(503).send({
          schemaVersion: 'v1',
          errorCode: 'public_read_unavailable',
          message: 'Public channel data is temporarily unavailable',
          traceId: request.id,
          retryable: true,
        });
      }

      const channel = await repository.findByHandle(request.params.handle);
      if (channel) {
        return reply.code(200).send({
          channelId: channel.channelId,
          handle: channel.handle,
          displayName: channel.displayName,
          acceptingTips: channel.acceptingTips,
          minimumTipPaise: channel.minimumTipPaise,
          publicConfigVersion: channel.publicConfigVersion,
        });
      }

      // The requested handle isn't live. It may be a handle this channel
      // released in a rename (see channel_handle_history in
      // packages/db/migrations/0087_v1_l03_channel_handle_reservation.sql)
      // — resolve it to the channel's current handle so a stale outbound
      // link still lands the visitor on a working page, rather than
      // treating every non-live handle as if it never existed. A handle
      // that truly never existed also resolves to nothing here, so it
      // still falls through to the same 404 below; the extra field below
      // is the only difference a resolved rename ever exposes.
      const renamed = await repository.resolveReleasedHandle?.(request.params.handle);
      if (renamed) {
        return reply.code(200).send({
          channelId: renamed.channelId,
          handle: renamed.handle,
          displayName: renamed.displayName,
          acceptingTips: renamed.acceptingTips,
          minimumTipPaise: renamed.minimumTipPaise,
          publicConfigVersion: renamed.publicConfigVersion,
          renamedFrom: request.params.handle,
        });
      }

      return reply.code(404).send({
        schemaVersion: 'v1',
        errorCode: 'not_found',
        message: 'Channel not found',
        traceId: request.id,
      });
    },
  );

  // Self-serve opt-in (channels.featured_consent, toggled via
  // PATCH /v1/channels/:channelId) plus an automatic eligibility filter —
  // no admin curation step. See packages/db/migrations/
  // 0072_v1_l03_featured_creator_listing.sql for why the projection is
  // deliberately narrower than /v1/public/channels/:handle.
  app.get<{ Querystring: { limit?: number } }>(
    '/v1/public/featured',
    {
      schema: { querystring: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 60 } } } },
      // This is the one route the marketing site's static export calls
      // cross-origin (see bharatstudio-marketing's generate-csp-headers.mjs
      // /creators/-only connect-src widening) — the app-wide CORS policy
      // registered in app.ts is deliberately locked to the single
      // credentialed web-app origin and must stay that way for every
      // authenticated route. This route is public, read-only, carries no
      // credentials and no per-user data, so it is the one place a
      // wildcard origin is safe; every other route keeps the strict
      // single-origin policy untouched.
      onSend: async (_request, reply, payload) => {
        reply.header('access-control-allow-origin', '*');
        return payload;
      },
    },
    async (request, reply) => {
      if (!repository) {
        return reply.code(503).send({
          schemaVersion: 'v1',
          errorCode: 'public_read_unavailable',
          message: 'Public channel data is temporarily unavailable',
          traceId: request.id,
          retryable: true,
        });
      }
      const creators = await repository.listFeatured(request.query.limit ?? 60);
      return reply.code(200).send({ schemaVersion: 'v1', creators });
    },
  );

  app.post<{
    Params: { handle: string };
    Headers: { 'idempotency-key'?: string };
    Body: {
      amountPaise: number;
      currency: 'INR';
      donorDisplayName?: string | null;
      message?: string | null;
      alertConsent?: boolean;
      turnstileToken?: string | null;
      // L16 gap closure (0108): tag this tip toward a paid support-vote
      // option. Both or neither — a lone interactionDefinitionId/
      // voteOptionKey is ignored, never a 400 (see the call site: a bad
      // or mismatched tag must never fail the underlying tip).
      interactionDefinitionId?: string | null;
      voteOptionKey?: string | null;
    };
  }>(
    '/v1/public/channels/:handle/tips/orders',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['handle'],
          properties: {
            handle: { type: 'string', minLength: 1, maxLength: 64, pattern: handlePattern },
          },
        },
        headers: {
          type: 'object',
          additionalProperties: true,
          required: ['idempotency-key'],
          properties: { 'idempotency-key': { type: 'string', minLength: 16, maxLength: 128, pattern: idempotencyKeyPattern } },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['amountPaise', 'currency'],
          properties: {
            amountPaise: { type: 'integer', minimum: 1000 },
            currency: { type: 'string', const: 'INR' },
            donorDisplayName: { type: ['string', 'null'], maxLength: 80 },
            message: { type: ['string', 'null'], maxLength: 500 },
            alertConsent: { type: 'boolean', default: true },
            turnstileToken: { type: ['string', 'null'], maxLength: 2048 },
            interactionDefinitionId: { type: ['string', 'null'], format: 'uuid' },
            voteOptionKey: { type: ['string', 'null'], pattern: '^[a-z0-9_-]{1,40}$' },
          },
        },
      },
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      if (!repository || !paymentOrders) {
        return reply.code(503).send({
          schemaVersion: 'v1',
          errorCode: 'payment_unavailable',
          message: 'Secure checkout is temporarily unavailable',
          traceId: request.id,
          retryable: true,
        });
      }

      if (turnstileRequired) {
        const token = typeof request.body.turnstileToken === 'string' ? request.body.turnstileToken : '';
        if (!abuseGuard || !(await abuseGuard.verify(token, request.ip))) {
          return reply.code(403).send({ schemaVersion: 'v1', errorCode: 'bot_verification_required', message: 'Please complete the security check and try again', traceId: request.id, retryable: false });
        }
      }

      const idempotencyKey = request.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)) {
        return reply.code(400).send({
          schemaVersion: 'v1',
          errorCode: 'invalid_idempotency_key',
          message: 'A valid Idempotency-Key header is required',
          traceId: request.id,
          retryable: false,
        });
      }

      // A tip must still complete through a stale link even when a donor
      // (or a stream overlay widget with the old handle baked in) posts
      // straight to the API without ever going through the redirecting
      // /tips/[handle] page — so resolve a released handle the same way
      // the GET lookup above does before failing closed to 404.
      const channel = (await repository.findByHandle(request.params.handle))
        ?? (await repository.resolveReleasedHandle?.(request.params.handle));
      if (!channel) {
        return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Channel not found', traceId: request.id });
      }
      if (!channel.acceptingTips) {
        return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'tips_closed', message: 'This channel is not accepting tips', traceId: request.id });
      }
      if (request.body.amountPaise < channel.minimumTipPaise) {
        return reply.code(400).send({
          schemaVersion: 'v1',
          errorCode: 'tip_below_channel_minimum',
          message: `This channel requires a minimum tip of ₹${Math.ceil(channel.minimumTipPaise / 100).toLocaleString('en-IN')}`,
          traceId: request.id,
          retryable: false,
        });
      }

      // L16 gap closure (0108): tag this tip toward a paid support-vote
      // option BEFORE the order is created, keyed by the same
      // (channelId, environment, idempotencyKey) triple the payment
      // itself will settle under — see 0108's migration header for the
      // full join chain this tag enables. A donor sending a stale/invalid
      // definitionId, an option that doesn't exist, or a definition not
      // in paid mode must never break their tip: app_private.
      // tag_vote_payment validates all of that and rejects, and this
      // call site swallows that rejection rather than surfacing it —
      // the checkout itself is the thing that must never fail here.
      if (votePaymentTags && request.body.interactionDefinitionId && request.body.voteOptionKey) {
        try {
          await votePaymentTags.tag({
            channelId: channel.channelId,
            environment: paymentEnvironment,
            idempotencyKey,
            interactionDefinitionId: request.body.interactionDefinitionId,
            optionKey: request.body.voteOptionKey,
          });
        } catch (error) {
          logSafeError(request, 'vote_payment_tag_failed', error);
        }
      }

      const providerReceipt = `bsa_${createHash('sha256').update(`${channel.channelId}:${idempotencyKey}`).digest('hex').slice(0, 32)}`;
      try {
        const order = await paymentOrders.createTipOrder({
          channelId: channel.channelId,
          environment: paymentEnvironment,
          idempotencyKey,
          intentId: randomUUID(),
          providerReceipt,
          amountPaise: request.body.amountPaise,
          currency: 'INR',
          donorDisplayName: request.body.donorDisplayName ?? '',
          message: request.body.message ?? '',
          alertConsent: request.body.alertConsent !== false,
          expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        }, request.id);
        return reply.code(201).send(order);
      } catch (error) {
        logSafeError(request, 'tip_order_creation_failed', error);
        return reply.code(503).send({
          schemaVersion: 'v1',
          errorCode: 'payment_unavailable',
          message: 'Secure checkout is temporarily unavailable',
          traceId: request.id,
          retryable: true,
        });
      }
    },
  );

  app.get<{ Params: { orderId: string } }>(
    '/v1/public/tip-orders/:orderId/status',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['orderId'],
          properties: { orderId: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request, reply) => {
      if (!paymentStatus) {
        return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'payment_status_unavailable', message: 'Payment status is temporarily unavailable', traceId: request.id, retryable: true });
      }
      const status = await paymentStatus.findByOrderId(request.params.orderId);
      if (!status) return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Payment order not found', traceId: request.id });
      const publicStatus = status.status === 'paid'
        ? 'paid'
        : status.status === 'expired'
          ? 'expired'
          : status.status === 'failed'
            ? 'failed'
            : 'pending';
      return reply.code(200).send({ schemaVersion: 'v1', orderId: status.orderId, status: publicStatus, amountPaise: status.amountPaise, currency: status.currency, updatedAt: status.updatedAt });
    },
  );

  // ---------------------------------------------------------------------
  // TipIntent + opaque short link (L15 task 7/8/17). Internal creation is
  // NOT a public/unauthenticated route (it is shared-secret protected —
  // the caller is a service, e.g. the YouTube chat poller, not a viewer's
  // browser); resolution and confirmation ARE unauthenticated public
  // routes, since a viewer reaches them with nothing but the token.
  // ---------------------------------------------------------------------

  app.post<{
    Body: {
      channelId: string;
      amountPaise: number;
      donorDisplayName?: string | null;
      message?: string | null;
      sourcePlatform: 'youtube';
      sourceChannelUserId?: string | null;
    };
  }>(
    '/v1/public/internal/tip-intents',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['channelId', 'amountPaise', 'sourcePlatform'],
          properties: {
            channelId: { type: 'string', format: 'uuid' },
            amountPaise: { type: 'integer', minimum: 100, maximum: 10000000 },
            donorDisplayName: { type: ['string', 'null'], maxLength: 80 },
            message: { type: ['string', 'null'], maxLength: 500 },
            sourcePlatform: { type: 'string', const: 'youtube' },
            sourceChannelUserId: { type: ['string', 'null'], maxLength: 128 },
          },
        },
      },
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      if (!tipIntents || !tipIntentCreationSecret) {
        return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'tip_intent_unavailable', message: 'TipIntent creation is temporarily unavailable', traceId: request.id, retryable: true });
      }
      const providedSecret = request.headers['x-connector-secret'];
      if (typeof providedSecret !== 'string' || !secretsMatch(providedSecret, tipIntentCreationSecret)) {
        return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'unauthorized', message: 'Invalid connector credentials', traceId: request.id });
      }
      try {
        const created = await tipIntents.create({
          channelId: request.body.channelId,
          amountPaise: request.body.amountPaise,
          donorDisplayName: request.body.donorDisplayName ?? null,
          message: request.body.message ?? null,
          sourcePlatform: request.body.sourcePlatform,
          sourceChannelUserId: request.body.sourceChannelUserId ?? null,
        });
        return reply.code(201).send({
          schemaVersion: 'v1',
          token: created.token,
          shortLink: `${tipIntentShortLinkOrigin}/t/${created.token}`,
          expiresAt: created.expiresAt,
        });
      } catch (error) {
        logSafeError(request, 'tip_intent_creation_failed', error);
        return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'tip_intent_unavailable', message: 'TipIntent creation is temporarily unavailable', traceId: request.id, retryable: true });
      }
    },
  );

  // Read-only resolution for the /t/<token> confirmation page. The token
  // must NEVER carry the amount/name/message itself — this is the one
  // lookup that turns an opaque token into those values, and it is
  // rate-limited because it is unauthenticated and public (brute-forcing
  // a 50-bit token is the threat this route defends against, alongside
  // the token's own short lifetime — see db/tipintent-store.ts).
  app.get<{ Params: { token: string } }>(
    '/v1/public/tip-intents/:token',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['token'],
          properties: { token: { type: 'string', pattern: TIPINTENT_TOKEN_PATTERN } },
        },
      },
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      if (!tipIntents) {
        return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'tip_intent_unavailable', message: 'This support link is temporarily unavailable', traceId: request.id, retryable: true });
      }
      const resolved = await tipIntents.resolve(request.params.token);
      if (resolved.state === 'unknown') {
        return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', state: 'unknown', message: 'This support link does not exist', traceId: request.id });
      }
      if (resolved.state === 'ready') {
        return reply.code(200).send({
          schemaVersion: 'v1',
          state: 'ready',
          channelHandle: resolved.channelHandle,
          channelDisplayName: resolved.channelDisplayName,
          amountPaise: resolved.amountPaise,
          currency: resolved.currency,
          donorDisplayName: resolved.donorDisplayName,
          message: resolved.message,
        });
      }
      // 'used' or 'expired': channel identity is shown so the page can
      // say who the link was for, but never the amount/name/message —
      // those only ever come back for a still-'ready' token.
      return reply.code(200).send({
        schemaVersion: 'v1',
        state: resolved.state,
        channelHandle: resolved.channelHandle,
        channelDisplayName: resolved.channelDisplayName,
      });
    },
  );

  // Confirmation hand-off into the EXISTING tip-order flow
  // (POST /v1/public/channels/:handle/tips/orders above). The body
  // schema deliberately accepts nothing but an optional turnstileToken —
  // amountPaise/donorDisplayName/message are REJECTED as unknown
  // properties (additionalProperties: false) if a client sends them, and
  // even if that guard were removed, the values used to create the order
  // always come from consume()'s server-side row, never from the
  // request body. This is what makes editing the URL/body unable to
  // change what the creator receives.
  app.post<{
    Params: { token: string };
    Headers: { 'idempotency-key'?: string };
    Body: { turnstileToken?: string | null };
  }>(
    '/v1/public/tip-intents/:token/orders',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['token'],
          properties: { token: { type: 'string', pattern: TIPINTENT_TOKEN_PATTERN } },
        },
        headers: {
          type: 'object',
          additionalProperties: true,
          required: ['idempotency-key'],
          properties: { 'idempotency-key': { type: 'string', minLength: 16, maxLength: 128, pattern: idempotencyKeyPattern } },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { turnstileToken: { type: ['string', 'null'], maxLength: 2048 } },
        },
      },
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      if (!tipIntents || !paymentOrders) {
        return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'payment_unavailable', message: 'Secure checkout is temporarily unavailable', traceId: request.id, retryable: true });
      }
      const idempotencyKey = request.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)) {
        return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_idempotency_key', message: 'A valid Idempotency-Key header is required', traceId: request.id, retryable: false });
      }
      if (turnstileRequired) {
        const token = typeof request.body.turnstileToken === 'string' ? request.body.turnstileToken : '';
        if (!abuseGuard || !(await abuseGuard.verify(token, request.ip))) {
          return reply.code(403).send({ schemaVersion: 'v1', errorCode: 'bot_verification_required', message: 'Please complete the security check and try again', traceId: request.id, retryable: false });
        }
      }

      // Pre-check via the read-only resolve() so a client gets the right
      // human-readable state (used/expired/unknown) instead of a generic
      // failure when the token cannot be redeemed. The actual claim below
      // is still atomic and authoritative — this check narrows the error
      // code, it never widens what consume() is willing to accept.
      const preCheck = await tipIntents.resolve(request.params.token);
      if (preCheck.state === 'unknown') {
        return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'This support link does not exist', traceId: request.id });
      }
      if (preCheck.state === 'used') {
        return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'tip_intent_already_used', message: 'This support link has already been used', traceId: request.id });
      }
      if (preCheck.state === 'expired') {
        return reply.code(410).send({ schemaVersion: 'v1', errorCode: 'tip_intent_expired', message: 'This support link has expired', traceId: request.id });
      }

      const intentId = randomUUID();
      const consumed = await tipIntents.consume(request.params.token, intentId);
      if (!consumed) {
        // Lost a race with another request for the same single-use token
        // between the pre-check above and this atomic claim.
        return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'tip_intent_already_used', message: 'This support link has already been used', traceId: request.id });
      }

      const providerReceipt = `bsati_${createHash('sha256').update(`${consumed.channelId}:${intentId}`).digest('hex').slice(0, 32)}`;
      try {
        const order = await paymentOrders.createTipOrder({
          channelId: consumed.channelId,
          environment: paymentEnvironment,
          idempotencyKey,
          intentId,
          providerReceipt,
          amountPaise: consumed.amountPaise,
          currency: consumed.currency,
          donorDisplayName: consumed.donorDisplayName ?? '',
          message: consumed.message ?? '',
          alertConsent: true,
          expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        }, request.id);
        return reply.code(201).send(order);
      } catch (error) {
        // The TipIntent is now consumed but no order exists — the token
        // cannot be replayed (single-use, by design). Logged for
        // operator follow-up; see "Remaining open" in the delivery
        // report for this known tradeoff.
        logSafeError(request, 'tip_intent_order_creation_failed', error);
        return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'payment_unavailable', message: 'Secure checkout is temporarily unavailable', traceId: request.id, retryable: true });
      }
    },
  );
}
