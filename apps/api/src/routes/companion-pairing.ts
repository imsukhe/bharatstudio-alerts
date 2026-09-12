import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import type { CompanionPairingStore } from '../domain/companion-pairing.js';
import { logSafeError } from '../observability/safe-log.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const userCodePattern = '^[A-HJ-NP-Z2-9]{8}$';
const userCodeParams = { type: 'object', additionalProperties: false, required: ['userCode'], properties: { userCode: { type: 'string', pattern: userCodePattern } } } as const;

// GET/approve/deny all take a caller-supplied user_code — the one guessable
// surface in this flow (see migration 0082's brute-force mitigation
// comment). Throttled well below the app-wide 120/min limiter in app.ts.
const userCodeRouteRateLimit = { max: 20, timeWindow: '1 minute' } as const;
const startRouteRateLimit = { max: 30, timeWindow: '1 minute' } as const;
const tokenRouteRateLimit = { max: 60, timeWindow: '1 minute' } as const;

function unavailable(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string) {
  return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'companion_pairing_unavailable', message: 'Companion pairing is temporarily unavailable', traceId, retryable: true });
}

export async function registerCompanionPairingRoutes(app: FastifyInstance, sessions?: SessionStore, pairing?: CompanionPairingStore): Promise<void> {
  const auth = requireAuth(sessions);

  app.post<{ Body: { clientType: 'desktop'; clientInstanceId: string; clientLabel: string } }>('/v1/companion/pairing/device', {
    config: { rateLimit: startRouteRateLimit },
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['clientType', 'clientInstanceId', 'clientLabel'],
        properties: {
          clientType: { type: 'string', enum: ['desktop'] },
          clientInstanceId: { type: 'string', minLength: 16, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' },
          clientLabel: { type: 'string', minLength: 1, maxLength: 80 },
        },
      },
    },
  }, async (request, reply) => {
    if (!pairing) return unavailable(reply, request.id);
    try {
      const result = await pairing.startDevicePairing(request.body.clientType, request.body.clientInstanceId, request.body.clientLabel);
      return reply.code(201).send(result);
    } catch (error) {
      logSafeError(request, 'companion_pairing_start_failed', error);
      return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'companion_pairing_invalid', message: 'Companion pairing could not be started', traceId: request.id, retryable: false });
    }
  });

  app.post<{ Body: { deviceCode: string } }>('/v1/companion/pairing/device/token', {
    config: { rateLimit: tokenRouteRateLimit },
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['deviceCode'],
        properties: { deviceCode: { type: 'string', minLength: 16, maxLength: 512 } },
      },
    },
  }, async (request, reply) => {
    if (!pairing) return unavailable(reply, request.id);
    try {
      const result = await pairing.pollDeviceToken(request.body.deviceCode);
      return reply.code(200).send(result);
    } catch (error) {
      logSafeError(request, 'companion_pairing_poll_failed', error);
      return reply.code(200).send({ schemaVersion: 'v1', status: 'expired_token' });
    }
  });

  app.get<{ Params: { userCode: string } }>('/v1/companion/pairing/:userCode', {
    preHandler: auth,
    config: { rateLimit: userCodeRouteRateLimit },
    schema: { params: userCodeParams },
  }, async (request, reply) => {
    if (!pairing || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await pairing.getPairingRequest(request.auth.userId, request.params.userCode);
      return result ? reply.code(200).send(result) : reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Companion pairing request not found', traceId: request.id });
    } catch (error) {
      logSafeError(request, 'companion_pairing_lookup_failed', error);
      return reply.code(403).send({ schemaVersion: 'v1', errorCode: 'forbidden', message: 'Companion pairing access denied', traceId: request.id, retryable: false });
    }
  });

  app.post<{ Params: { userCode: string }; Body: { channelId: string } }>('/v1/companion/pairing/:userCode/approve', {
    preHandler: auth,
    config: { rateLimit: userCodeRouteRateLimit },
    schema: {
      params: userCodeParams,
      body: { type: 'object', additionalProperties: false, required: ['channelId'], properties: { channelId: uuid } },
    },
  }, async (request, reply) => {
    if (!pairing || !request.auth) return unavailable(reply, request.id);
    try {
      const approved = await pairing.approvePairing(request.auth.userId, request.params.userCode, request.body.channelId);
      return approved ? reply.code(200).send({ schemaVersion: 'v1', approved: true }) : reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Companion pairing request not found', traceId: request.id });
    } catch (error) {
      logSafeError(request, 'companion_pairing_approve_failed', error);
      const message = error instanceof Error ? error.message : '';
      if (/access denied/i.test(message)) return reply.code(403).send({ schemaVersion: 'v1', errorCode: 'forbidden', message: 'Companion pairing access denied', traceId: request.id, retryable: false });
      return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'companion_pairing_invalid', message: 'Companion pairing could not be approved', traceId: request.id, retryable: false });
    }
  });

  app.post<{ Params: { userCode: string } }>('/v1/companion/pairing/:userCode/deny', {
    preHandler: auth,
    config: { rateLimit: userCodeRouteRateLimit },
    schema: { params: userCodeParams },
  }, async (request, reply) => {
    if (!pairing || !request.auth) return unavailable(reply, request.id);
    try {
      const denied = await pairing.denyPairing(request.auth.userId, request.params.userCode);
      return denied ? reply.code(200).send({ schemaVersion: 'v1', denied: true }) : reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Companion pairing request not found', traceId: request.id });
    } catch (error) {
      logSafeError(request, 'companion_pairing_deny_failed', error);
      return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'companion_pairing_invalid', message: 'Companion pairing could not be denied', traceId: request.id, retryable: false });
    }
  });
}
