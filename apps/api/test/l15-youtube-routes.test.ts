import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import type { RuntimeConfig } from '../src/config.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { YoutubeConnection, YoutubeConnectionStore } from '../src/domain/youtube-connection.js';
import type { YoutubeOAuthClient } from '../src/domain/youtube-oauth-client.js';

const config: RuntimeConfig = { nodeEnv: 'test', host: '127.0.0.1', port: 4101, appOrigin: 'http://localhost:3100', paymentEnvironment: 'test' };
const userId = '00000000-0000-4000-8000-000000000201';
const channelId = '00000000-0000-4000-8000-000000000211';
const authHeaders = { authorization: `Bearer ${'b'.repeat(48)}` };

const sessions: SessionStore = {
  async create() { throw new Error('not used'); },
  async lookup(token) { return token === 'b'.repeat(48) ? { sessionId: '00000000-0000-4000-8000-000000000203', userId, expiresAt: '2026-09-06T00:00:00.000Z' } : null; },
  async getCurrentUser() { throw new Error('not used'); }, async list() { return []; }, async revoke() { return false; },
};

class PgError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

const oauthClient: YoutubeOAuthClient = {
  redirectUri: 'https://app.example.test/oauth/youtube/callback',
  buildAuthorizationUrl({ state }) { return `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`; },
  async exchangeCode() { return { accessToken: 'synthetic-access-token', refreshToken: 'synthetic-refresh-token', expiresInSeconds: 3600, grantedScopes: ['https://www.googleapis.com/auth/youtube.readonly'] }; },
  async fetchChannelIdentity() { return { externalChannelId: 'UC_synthetic', externalChannelTitle: 'Synthetic Channel' }; },
};

const connection: YoutubeConnection = {
  schemaVersion: 'v1', connectionId: '00000000-0000-4000-8000-000000000241', externalChannelId: 'UC_synthetic',
  externalChannelTitle: 'Synthetic Channel', grantedScopes: ['https://www.googleapis.com/auth/youtube.readonly'],
  status: 'active', createdAt: '2026-09-06T00:00:00.000Z', updatedAt: '2026-09-06T00:00:00.000Z', revokedAt: null,
};

async function buildYoutubeApp(store: YoutubeConnectionStore) {
  // buildApp now registers the YouTube routes itself (app.ts), so pass the
  // dependencies through it rather than registering a second copy.
  const app = await buildApp(config, {
    sessions,
    youtubeConnections: store,
    youtubeOAuthClient: oauthClient,
  });
  await app.ready();
  return app;
}

test('connect requires authentication and returns a PKCE-bearing authorization URL with state on success', async () => {
  let beganState = '';
  const store: YoutubeConnectionStore = {
    async list() { return []; },
    async beginOAuth(_user, _channel, params) { beganState = params.state; },
    async consumeOAuthState() { throw new Error('not used'); },
    async finalizeConnection() { throw new Error('not used'); },
    async revoke() { return false; },
  };
  const app = await buildYoutubeApp(store);
  const unauthorized = await app.inject({ method: 'POST', url: `/v1/channels/${channelId}/connectors/youtube/connect` });
  assert.equal(unauthorized.statusCode, 401);

  const started = await app.inject({ method: 'POST', url: `/v1/channels/${channelId}/connectors/youtube/connect`, headers: authHeaders });
  assert.equal(started.statusCode, 200);
  const body = started.json();
  assert.equal(body.state, beganState);
  assert.match(body.authorizationUrl, /^https:\/\/accounts\.google\.com\//);
  await app.close();
});

test('connect rejects once the channel is at its connector entitlement limit', async () => {
  const store: YoutubeConnectionStore = {
    async list() { return []; },
    async beginOAuth() { throw new PgError('42501', 'youtube connector entitlement limit reached'); },
    async consumeOAuthState() { throw new Error('not used'); },
    async finalizeConnection() { throw new Error('not used'); },
    async revoke() { return false; },
  };
  const app = await buildYoutubeApp(store);
  const rejected = await app.inject({ method: 'POST', url: `/v1/channels/${channelId}/connectors/youtube/connect`, headers: authHeaders });
  assert.equal(rejected.statusCode, 403);
  assert.equal(rejected.json().errorCode, 'youtube_connector_entitlement_or_role_denied');
  await app.close();
});

test('callback rejects a mismatched or expired OAuth state without finalizing any connection', async () => {
  let finalizeCalled = false;
  const store: YoutubeConnectionStore = {
    async list() { return []; },
    async beginOAuth() {},
    async consumeOAuthState() { throw new PgError('22023', 'invalid or expired oauth state'); },
    async finalizeConnection() { finalizeCalled = true; return connection; },
    async revoke() { return false; },
  };
  const app = await buildYoutubeApp(store);
  const rejected = await app.inject({ method: 'GET', url: `/v1/connectors/youtube/callback?code=abc&state=does-not-match` });
  assert.equal(rejected.statusCode, 400);
  assert.equal(rejected.json().errorCode, 'youtube_oauth_state_invalid');
  assert.equal(finalizeCalled, false);
  await app.close();
});

test('callback with a valid state exchanges the code and finalizes the connection, never echoing token material', async () => {
  const store: YoutubeConnectionStore = {
    async list() { return []; },
    async beginOAuth() {},
    async consumeOAuthState(state) {
      assert.equal(state, 'valid-state-123');
      return { channelId, userId, codeVerifier: 'synthetic-verifier', redirectUri: oauthClient.redirectUri };
    },
    async finalizeConnection(_user, _channel, input) {
      assert.equal(input.accessToken, 'synthetic-access-token');
      assert.equal(input.externalChannelId, 'UC_synthetic');
      return connection;
    },
    async revoke() { return false; },
  };
  const app = await buildYoutubeApp(store);
  const completed = await app.inject({ method: 'GET', url: `/v1/connectors/youtube/callback?code=abc&state=valid-state-123` });
  assert.equal(completed.statusCode, 200);
  const body = completed.json();
  assert.equal(body.connection.status, 'active');
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /synthetic-access-token|synthetic-refresh-token/);
  await app.close();
});

test('list and revoke require authentication; revoke reports 404 for an unknown connection', async () => {
  const store: YoutubeConnectionStore = {
    async list() { return [connection]; },
    async beginOAuth() {},
    async consumeOAuthState() { throw new Error('not used'); },
    async finalizeConnection() { throw new Error('not used'); },
    async revoke() { return false; },
  };
  const app = await buildYoutubeApp(store);
  const unauthorizedList = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/connectors/youtube` });
  assert.equal(unauthorizedList.statusCode, 401);

  const listed = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/connectors/youtube`, headers: authHeaders });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().connections[0].connectionId, connection.connectionId);
  assert.equal(listed.json().connections[0].status, 'active');
  assert.ok(!('accessTokenCiphertext' in listed.json().connections[0]));

  const revoked = await app.inject({ method: 'DELETE', url: `/v1/channels/${channelId}/connectors/youtube/${connection.connectionId}`, headers: authHeaders });
  assert.equal(revoked.statusCode, 404);
  await app.close();
});
