import type { FastifyInstance } from 'fastify';
import { requireAuth, requireAuthAndTerms } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import type { AccountStore } from '../domain/account-store.js';
import type { YoutubeConnectionStore } from '../domain/youtube-connection.js';
import type { YoutubeOAuthClient } from '../domain/youtube-oauth-client.js';
import { generateOAuthState, generatePkceCodeVerifier } from '../domain/youtube-oauth-client.js';

const channelParams = { type: 'object', additionalProperties: false, required: ['channelId'], properties: { channelId: { type: 'string', format: 'uuid' } } } as const;
const connectionParams = {
  type: 'object', additionalProperties: false, required: ['channelId', 'connectionId'],
  properties: { channelId: { type: 'string', format: 'uuid' }, connectionId: { type: 'string', format: 'uuid' } },
} as const;
const callbackQuerystring = {
  type: 'object', additionalProperties: false, required: ['code', 'state'],
  properties: { code: { type: 'string', minLength: 1, maxLength: 2048 }, state: { type: 'string', minLength: 1, maxLength: 128 } },
} as const;

function isSqlstate(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === code;
}

const STORE_UNAVAILABLE = {
  schemaVersion: 'v1' as const,
  errorCode: 'youtube_connector_store_unavailable',
  message: 'YouTube connector settings are temporarily unavailable',
  retryable: true,
};

export async function registerYoutubeRoutes(
  app: FastifyInstance,
  sessions?: SessionStore,
  store?: YoutubeConnectionStore,
  account?: AccountStore,
  oauthClient?: YoutubeOAuthClient,
): Promise<void> {
  const auth = requireAuth(sessions);
  const termsAuth = requireAuthAndTerms(sessions, account);

  app.get<{ Params: { channelId: string } }>(
    '/v1/channels/:channelId/connectors/youtube',
    { preHandler: auth, schema: { params: channelParams } },
    async (request, reply) => {
      if (!store || !request.auth) return reply.code(503).send({ ...STORE_UNAVAILABLE, traceId: request.id });
      const connections = await store.list(request.auth.userId, request.params.channelId);
      return reply.send({ schemaVersion: 'v1', connections });
    },
  );

  app.post<{ Params: { channelId: string } }>(
    '/v1/channels/:channelId/connectors/youtube/connect',
    { preHandler: termsAuth, schema: { params: channelParams } },
    async (request, reply) => {
      if (!store || !oauthClient || !request.auth) return reply.code(503).send({ ...STORE_UNAVAILABLE, traceId: request.id });
      const state = generateOAuthState();
      const codeVerifier = generatePkceCodeVerifier();
      const authorizationUrl = oauthClient.buildAuthorizationUrl({ state, codeVerifier });
      try {
        await store.beginOAuth(request.auth.userId, request.params.channelId, {
          state,
          codeVerifier,
          redirectUri: oauthClient.redirectUri,
        });
      } catch (error) {
        if (isSqlstate(error, '42501')) {
          return reply.code(403).send({
            schemaVersion: 'v1', errorCode: 'youtube_connector_entitlement_or_role_denied',
            message: 'This channel cannot start a YouTube connection right now', traceId: request.id,
          });
        }
        throw error;
      }
      return reply.code(200).send({ schemaVersion: 'v1', authorizationUrl, state });
    },
  );

  // Google redirects the viewer's browser here after consent — this
  // request never carries our own bearer session, only ?code&state. The
  // channel/user are recovered from the single-use state row itself
  // (app_private.consume_youtube_oauth_state), which is why an invalid or
  // replayed state must be rejected rather than trusted.
  app.get<{ Querystring: { code: string; state: string } }>(
    '/v1/connectors/youtube/callback',
    { schema: { querystring: callbackQuerystring } },
    async (request, reply) => {
      if (!store || !oauthClient) return reply.code(503).send({ ...STORE_UNAVAILABLE, traceId: request.id });
      let consumed;
      try {
        consumed = await store.consumeOAuthState(request.query.state);
      } catch {
        return reply.code(400).send({
          schemaVersion: 'v1', errorCode: 'youtube_oauth_state_invalid',
          message: 'This YouTube connection attempt is invalid or has expired', traceId: request.id,
        });
      }
      try {
        const exchanged = await oauthClient.exchangeCode({ code: request.query.code, codeVerifier: consumed.codeVerifier });
        const identity = await oauthClient.fetchChannelIdentity(exchanged.accessToken);
        const connection = await store.finalizeConnection(consumed.userId, consumed.channelId, {
          externalChannelId: identity.externalChannelId,
          externalChannelTitle: identity.externalChannelTitle,
          scopes: exchanged.grantedScopes,
          accessToken: exchanged.accessToken,
          refreshToken: exchanged.refreshToken,
          tokenExpiresAt: new Date(Date.now() + exchanged.expiresInSeconds * 1000).toISOString(),
        });
        return reply.code(200).send({ schemaVersion: 'v1', channelId: consumed.channelId, connection });
      } catch (error) {
        if (isSqlstate(error, '42501')) {
          return reply.code(403).send({
            schemaVersion: 'v1', errorCode: 'youtube_connector_entitlement_limit_reached',
            message: 'This channel has reached its connected-platform limit', traceId: request.id,
          });
        }
        return reply.code(502).send({
          schemaVersion: 'v1', errorCode: 'youtube_connector_finalize_failed',
          message: 'The YouTube connection could not be completed', traceId: request.id, retryable: true,
        });
      }
    },
  );

  app.delete<{ Params: { channelId: string; connectionId: string } }>(
    '/v1/channels/:channelId/connectors/youtube/:connectionId',
    { preHandler: termsAuth, schema: { params: connectionParams } },
    async (request, reply) => {
      if (!store || !request.auth) return reply.code(503).send({ ...STORE_UNAVAILABLE, traceId: request.id });
      const revoked = await store.revoke(request.auth.userId, request.params.channelId, request.params.connectionId);
      return revoked
        ? reply.code(204).send()
        : reply.code(404).send({ schemaVersion: 'v1', errorCode: 'youtube_connection_not_found', message: 'YouTube connection not found', traceId: request.id });
    },
  );
}
