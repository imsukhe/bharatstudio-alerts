import type { FastifyInstance } from 'fastify';
import type { PublicChannelRepository } from '../domain/public-channel.js';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { PaymentOrderService, TipOrder } from '../domain/payment-order.js';
import { createRazorpayPaymentProvider } from '../domain/payment-provider-razorpay.js';
import type { CreatePaymentResult } from '../domain/payment-provider-creator.js';
import type { PublicPaymentStatusRepository } from '../domain/public-payment-status.js';
import { logSafeError } from '../observability/safe-log.js';
import type { PublicAbuseGuard } from '../domain/public-abuse.js';
import type { TipIntentRepository } from '../domain/tipintent-types.js';
import { TIPINTENT_TOKEN_PATTERN } from '../db/tipintent-store.js';
// L16 gap closure (0108): let a tip carry a paid-vote option tag. See the
// call site below for why a tagging failure never fails the underlying
// checkout.
import type { PublicPaidVoteStore, VotePaymentTagStore } from '../domain/vote-payment-types.js';
// PRF-02 slice 6 / PRF-06, §6 module #5 (Reaction Cloud): the public,
// unauthenticated send path. See the route below for which existing
// public-surface protection guards it and why no new one was invented.
import { REACTION_ENTRY_SOURCES, type ReactionSendStore } from '../domain/reaction-cloud-store.js';

const handlePattern = '^[A-Za-z0-9._-]+$';
const idempotencyKeyPattern = '^[A-Za-z0-9._:-]+$';
const anonymousIdentityCookie = '__Host-bsa-anonymous';

function anonymousTokenFromCookie(header: string | undefined): string | undefined {
  const value = header?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${anonymousIdentityCookie}=`))?.slice(anonymousIdentityCookie.length + 1);
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}

function anonymousTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function anonymousCookie(token: string): string {
  // __Host- cookies are only valid with Secure + Path=/ and no Domain.  Keep
  // the invariant in every environment rather than quietly weakening it in a
  // development branch; test clients can still inspect the header directly.
  return `${anonymousIdentityCookie}=${token}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax; Secure`;
}

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
  votePaymentTags?: VotePaymentTagStore,
  // The public page gets this strict projection, never the creator-facing
  // interaction configuration. Optional preserves testable fail-closed
  // behavior if runtime wiring is missing.
  publicPaidVotes?: PublicPaidVoteStore,
  // PRF-02 slice 6 / PRF-06. Appended at the end so every existing
  // positional call keeps compiling unchanged; when undefined the reaction
  // route fails closed to 503, exactly like the other optional
  // dependencies in this file.
  reactionSends?: ReactionSendStore,
): Promise<void> {
  // L19: the live money-moving tip-order path now goes through
  // CreatorPaymentProvider.createPayment rather than calling paymentOrders
  // directly — see this task's report, "The tip flow, before and after".
  // No accountStore is available in this route file (registerPublicRoutes
  // never received one, and app.ts is out of this task's file ownership),
  // so this provider instance only ever has createPayment wired; its
  // account-connect methods are simply never called from here. Guard
  // conditions below are unchanged (`!paymentOrders`), so behaviour when
  // paymentOrders itself is unconfigured is identical to before this task.
  const razorpayProvider = createRazorpayPaymentProvider(undefined, paymentOrders);

  // Reconstructs the exact TipOrder shape this route always returned,
  // from the provider-neutral CreatePaymentResult — see
  // CreatePaymentResult's doc comment in payment-provider-creator.ts for
  // why the mapping is 1:1 and lossless for a real tip order.
  function toTipOrder(result: CreatePaymentResult): TipOrder {
    if (result.orderId === null || result.amountPaise === null || result.currency === null) {
      throw new Error('razorpay createPayment did not return a full tip order');
    }
    return {
      schemaVersion: 'v1',
      orderId: result.orderId,
      provider: 'razorpay',
      providerOrderId: result.providerPaymentRef,
      amountPaise: result.amountPaise,
      currency: result.currency,
      status: result.status,
    };
  }

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

  app.get<{ Params: { handle: string } }>(
    '/v1/public/channels/:handle/paid-votes',
    {
      schema: {
        params: {
          type: 'object', additionalProperties: false, required: ['handle'],
          properties: { handle: { type: 'string', minLength: 1, maxLength: 64, pattern: handlePattern } },
        },
      },
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      if (!repository || !publicPaidVotes) {
        return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'interaction_unavailable', message: 'Support choices are temporarily unavailable', traceId: request.id, retryable: true });
      }
      const channel = (await repository.findByHandle(request.params.handle))
        ?? (await repository.resolveReleasedHandle?.(request.params.handle));
      if (!channel) return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Channel not found', traceId: request.id });
      try {
        const items = await publicPaidVotes.listForChannel(channel.channelId);
        return reply.code(200).send({ schemaVersion: 'v1', items });
      } catch (error) {
        logSafeError(request, 'public_paid_vote_list_failed', error);
        return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'interaction_unavailable', message: 'Support choices are temporarily unavailable', traceId: request.id, retryable: true });
      }
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

      const hasDefinition = Boolean(request.body.interactionDefinitionId);
      const hasOption = Boolean(request.body.voteOptionKey);
      if (hasDefinition !== hasOption) {
        return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_interaction_selection', message: 'Choose a complete support-vote option or continue without one', traceId: request.id, retryable: false });
      }
      // A selected vote is a payment instruction, not optional decoration.
      // Validate/tag before provider order creation, so a stale or forged
      // selection cannot silently charge as an ordinary tip. An unselected
      // ordinary tip never enters this branch and retains existing behavior.
      if (hasDefinition && hasOption) {
        if (!votePaymentTags) {
          return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'interaction_unavailable', message: 'Support choices are temporarily unavailable', traceId: request.id, retryable: true });
        }
        try {
          const tagged = await votePaymentTags.tag({
            channelId: channel.channelId,
            environment: paymentEnvironment,
            idempotencyKey,
            interactionDefinitionId: request.body.interactionDefinitionId!,
            optionKey: request.body.voteOptionKey!,
          });
          if (tagged.outcome === 'invalid') {
            return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_interaction_selection', message: 'That support-vote choice is no longer available. Choose another option or continue without it', traceId: request.id, retryable: false });
          }
          if (tagged.outcome === 'unavailable') {
            return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'interaction_unavailable', message: 'Support choices are temporarily unavailable', traceId: request.id, retryable: true });
          }
        } catch (error) {
          logSafeError(request, 'vote_payment_tag_failed', error);
          return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'interaction_unavailable', message: 'Support choices are temporarily unavailable', traceId: request.id, retryable: true });
        }
      }

      const priorAnonymousToken = anonymousTokenFromCookie(request.headers.cookie);
      const issuedAnonymousToken = priorAnonymousToken ? undefined : randomBytes(32).toString('base64url');
      const anonymousIdentityTokenHash = anonymousTokenHash(priorAnonymousToken ?? issuedAnonymousToken!);
      const providerReceipt = `bsa_${createHash('sha256').update(`${channel.channelId}:${idempotencyKey}`).digest('hex').slice(0, 32)}`;
      try {
        const result = await razorpayProvider.createPayment({
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
          anonymousIdentityTokenHash,
          expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        }, request.id);
        if (issuedAnonymousToken) reply.header('set-cookie', anonymousCookie(issuedAnonymousToken));
        return reply.code(201).send(toTipOrder(result));
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
      const priorAnonymousToken = anonymousTokenFromCookie(request.headers.cookie);
      const issuedAnonymousToken = priorAnonymousToken ? undefined : randomBytes(32).toString('base64url');
      const anonymousIdentityTokenHash = anonymousTokenHash(priorAnonymousToken ?? issuedAnonymousToken!);
      try {
        const result = await razorpayProvider.createPayment({
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
          anonymousIdentityTokenHash,
          expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        }, request.id);
        if (issuedAnonymousToken) reply.header('set-cookie', anonymousCookie(issuedAnonymousToken));
        return reply.code(201).send(toTipOrder(result));
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

  // =====================================================================
  // PRF-02 slice 6 / PRF-06 -- §6 catalogue module #5 (Reaction Cloud):
  // the public, unauthenticated reaction SEND path.
  //
  // WHY THIS ROUTE IS UNAUTHENTICATED, STATED RATHER THAN ASSUMED. The
  // surface a reaction is sent from is the public tip page, which is
  // unauthenticated by construction -- the same surface that already
  // carries the sticker picker (GET
  // /v1/public/channels/:channelId/stickers, whose SQL function migration
  // 0110 documents as having "no auth/role check (the tip page is
  // unauthenticated)"). Requiring a viewer account would contradict two
  // already-decided things at once: §30.3 makes free reactions available
  // at every tier, and §6 #5 requires this surface to be NON-IDENTIFYING
  // -- an account is an identity.
  //
  // WHICH EXISTING PROTECTION IS REUSED, AND WHAT IS NOT INVENTED.
  //   * The SAME PublicAbuseGuard (Cloudflare Turnstile,
  //     domain/public-abuse.ts) behind the SAME `turnstileRequired` flag
  //     and returning the SAME 403 bot_verification_required envelope the
  //     two public payment POSTs above already use. No new flag, no new
  //     secret, no new envelope, no new verifier.
  //   * The rate limit is the creator's own per-channel
  //     one-minute SQL limit -- see below, and migration 0141.
  //
  // THE RATE LIMIT IS PER SENDER, 60 A MINUTE (owner direction,
  // 2026-09-17). It replaced a per-CHANNEL cap that reused the creator's
  // `rateLimitPerMinute`, for two reasons the owner named: a channel-level
  // cap THROTTLES THE CREATOR -- a popular stream exhausts the budget and
  // then refuses legitimate viewers -- and `rateLimitPerMinute` is the
  // creator's ALERT-SOURCE setting, which must not quietly acquire a second
  // meaning. The figure is owner-delegated ("plan a safe number for user")
  // and anchored to the paid-votes route above, the closest public-write
  // sibling, which already uses max 60 per 1 minute.
  //
  // There is deliberately NO `config.rateLimit` on this route: the
  // per-sender SQL limit is the reaction-specific figure, and the
  // pre-existing global @fastify/rate-limit registration in app.ts
  // (120/minute, IP-keyed) continues to apply here as it does everywhere,
  // unchanged by this work.
  //
  // THE SENDER KEY IS THE EXISTING ANONYMOUS BROWSER IDENTITY, OBTAINED
  // EXACTLY THE WAY CHECKOUT OBTAINS IT. The three steps below are the
  // identical three the two public checkout POSTs above perform: read
  // `__Host-bsa-anonymous`; mint one with randomBytes(32).toString(
  // 'base64url') and set the same cookie header when absent; SHA-256 it and
  // pass ONLY the hash onward. No second identity mechanism, cookie, header
  // or fingerprint is introduced, and the raw token never enters the
  // database.
  //
  // NOT AN IP. Indian mobile carriers use CGNAT heavily -- thousands of
  // genuine viewers share one address, so an IP-keyed reaction limit would
  // refuse them as a group, which is the same failure the owner just
  // removed.
  //
  // THE FINGERPRINT IS ADMISSION CONTROL AND NOTHING ELSE. It is not
  // written to the reaction row (0141 leaves channel_reaction_sends
  // untouched -- it still has no viewer, token, session or IP column), not
  // returned in any response, not logged, and not used as a metric label.
  // §6 #5's non-identifying rule is upheld on the write path and the read
  // path exactly as before.
  app.post<{ Params: { handle: string }; Body: { entrySource: 'catalogue' | 'creator_pack'; entryId: string; turnstileToken?: string | null } }>(
    '/v1/public/channels/:handle/reactions',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['handle'],
          properties: { handle: { type: 'string', minLength: 1, maxLength: 64, pattern: handlePattern } },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['entrySource', 'entryId'],
          properties: {
            entrySource: { type: 'string', enum: [...REACTION_ENTRY_SOURCES] },
            entryId: { type: 'string', format: 'uuid' },
            turnstileToken: { type: ['string', 'null'], maxLength: 2048 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!repository || !reactionSends) {
        return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'reaction_unavailable', message: 'Reactions are temporarily unavailable', traceId: request.id, retryable: true });
      }

      if (turnstileRequired) {
        const token = typeof request.body.turnstileToken === 'string' ? request.body.turnstileToken : '';
        if (!abuseGuard || !(await abuseGuard.verify(token, request.ip))) {
          return reply.code(403).send({ schemaVersion: 'v1', errorCode: 'bot_verification_required', message: 'Please complete the security check and try again', traceId: request.id, retryable: false });
        }
      }

      // The same released-handle fallback the tip-order route above uses,
      // for the same reason: a stale link must not silently stop working.
      const channel = (await repository.findByHandle(request.params.handle))
        ?? (await repository.resolveReleasedHandle?.(request.params.handle));
      if (!channel) {
        return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Channel not found', traceId: request.id });
      }

      // The existing anonymous-identity flow, step for step. Minting when
      // the cookie is absent is what lets an ordinary first-time visitor
      // react at all; a client that DISCARDS the cookie presents a new
      // fingerprint each time and so evades the per-sender limit, leaving
      // only app.ts's pre-existing global per-IP limit against it. That
      // residual is stated in the decision record rather than papered over.
      const priorSenderToken = anonymousTokenFromCookie(request.headers.cookie);
      const issuedSenderToken = priorSenderToken ? undefined : randomBytes(32).toString('base64url');
      const senderTokenHash = anonymousTokenHash(priorSenderToken ?? issuedSenderToken!);

      try {
        const outcome = await reactionSends.record(
          channel.channelId,
          request.body.entrySource,
          request.body.entryId,
          senderTokenHash,
        );
        if (issuedSenderToken) reply.header('set-cookie', anonymousCookie(issuedSenderToken));
        switch (outcome) {
          case 'recorded':
            return reply.code(201).send({ schemaVersion: 'v1', outcome: 'recorded' });
          case 'rate_limited':
            // THIS SENDER reached 60 sends inside the current one-minute
            // window. Retryable, because it will be false again within a
            // minute -- and it says nothing about the channel, which has no
            // budget of its own any more.
            return reply.code(429).send({ schemaVersion: 'v1', errorCode: 'reaction_rate_limited', message: 'You are sending reactions very quickly; try again in a moment', traceId: request.id, retryable: true });
          case 'sender_unidentified':
            // REFUSED, never silently accepted and never downgraded to the
            // ambient per-IP limit -- a fallback would make dropping a
            // cookie the cheapest route to the weaker limit. Unreachable in
            // the ordinary flow, since the cookie is minted just above;
            // this is the fail-closed answer to a caller that bypassed the
            // route or a wiring fault.
            return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'reaction_sender_unidentified', message: 'Reactions need your browser to accept a small anonymous cookie', traceId: request.id, retryable: false });
          case 'unknown_entry':
            return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'unknown_reaction_entry', message: 'That reaction does not exist', traceId: request.id, retryable: false });
          case 'not_available':
            return reply.code(403).send({ schemaVersion: 'v1', errorCode: 'reaction_entry_not_available', message: 'That reaction is not available on this channel', traceId: request.id, retryable: false });
        }
      } catch (error) {
        logSafeError(request, 'reaction_send_failed', error);
        return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'reaction_unavailable', message: 'Reactions are temporarily unavailable', traceId: request.id, retryable: true });
      }
    },
  );
}
