import type { FastifyInstance } from 'fastify';
import type { PublicChannelRepository } from '../domain/public-channel.js';
import { createHash, randomUUID } from 'node:crypto';
import type { PaymentOrderService } from '../domain/payment-order.js';
import type { PublicPaymentStatusRepository } from '../domain/public-payment-status.js';
import { logSafeError } from '../observability/safe-log.js';
import type { PublicAbuseGuard } from '../domain/public-abuse.js';

const handlePattern = '^[A-Za-z0-9._-]+$';
const idempotencyKeyPattern = '^[A-Za-z0-9._:-]+$';

export async function registerPublicRoutes(
  app: FastifyInstance,
  repository?: PublicChannelRepository,
  paymentOrders?: PaymentOrderService,
  paymentEnvironment: 'test' | 'live' = 'test',
  paymentStatus?: PublicPaymentStatusRepository,
  abuseGuard?: PublicAbuseGuard,
  turnstileRequired = false,
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
      if (!channel) {
        return reply.code(404).send({
          schemaVersion: 'v1',
          errorCode: 'not_found',
          message: 'Channel not found',
          traceId: request.id,
        });
      }

      return reply.code(200).send({
        channelId: channel.channelId,
        handle: channel.handle,
        displayName: channel.displayName,
        acceptingTips: channel.acceptingTips,
        minimumTipPaise: channel.minimumTipPaise,
        publicConfigVersion: channel.publicConfigVersion,
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
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 60 } } } } },
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

      const channel = await repository.findByHandle(request.params.handle);
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
}
