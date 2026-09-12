import { createHash, randomBytes } from 'node:crypto';
import type { YoutubeOAuthConfig } from './youtube-oauth-config.js';

// PKCE (RFC 7636) verifier/challenge generation. state and code_verifier
// are both required — never optional — for every connect attempt; see
// migration 0086's youtube_oauth_states table and
// app_private.begin_youtube_oauth/consume_youtube_oauth_state.
export function generateOAuthState(): string {
  return randomBytes(24).toString('base64url');
}

export function generatePkceCodeVerifier(): string {
  // base64url of 48 random bytes is 64 chars, inside RFC 7636's required
  // 43-128 character range and matching this table's own CHECK constraint.
  return randomBytes(48).toString('base64url');
}

export function pkceCodeChallengeS256(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier, 'utf8').digest('base64url');
}

export type YoutubeTokenExchangeResult = {
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number;
  grantedScopes: string[];
};

export type YoutubeChannelIdentity = {
  externalChannelId: string;
  externalChannelTitle: string | null;
};

export interface YoutubeOAuthClient {
  readonly redirectUri: string;
  buildAuthorizationUrl(params: { state: string; codeVerifier: string }): string;
  exchangeCode(params: { code: string; codeVerifier: string }): Promise<YoutubeTokenExchangeResult>;
  fetchChannelIdentity(accessToken: string): Promise<YoutubeChannelIdentity>;
}

// Real implementation talks to Google's OAuth and YouTube Data API
// endpoints over fetch. Every request target comes from config (never
// hardcoded), and no client secret or token is ever logged.
export function createYoutubeOAuthClient(config: YoutubeOAuthConfig, fetchImpl: typeof fetch = fetch): YoutubeOAuthClient {
  return {
    redirectUri: config.redirectUri,
    buildAuthorizationUrl({ state, codeVerifier }) {
      const url = new URL(config.authorizationEndpoint);
      url.searchParams.set('client_id', config.clientId);
      url.searchParams.set('redirect_uri', config.redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('access_type', 'offline');
      url.searchParams.set('prompt', 'consent');
      url.searchParams.set('scope', config.scopes.join(' '));
      url.searchParams.set('state', state);
      url.searchParams.set('code_challenge', pkceCodeChallengeS256(codeVerifier));
      url.searchParams.set('code_challenge_method', 'S256');
      return url.toString();
    },
    async exchangeCode({ code, codeVerifier }) {
      const response = await fetchImpl(config.tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          redirect_uri: config.redirectUri,
          grant_type: 'authorization_code',
          code,
          code_verifier: codeVerifier,
        }).toString(),
      });
      if (!response.ok) throw new Error('YouTube OAuth token exchange failed');
      const payload = (await response.json()) as {
        access_token: string;
        refresh_token?: string;
        expires_in: number;
        scope?: string;
      };
      return {
        accessToken: payload.access_token,
        refreshToken: payload.refresh_token ?? null,
        expiresInSeconds: payload.expires_in,
        grantedScopes: payload.scope ? payload.scope.split(' ').filter(Boolean) : config.scopes,
      };
    },
    async fetchChannelIdentity(accessToken) {
      const response = await fetchImpl('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) throw new Error('YouTube channel identity lookup failed');
      const payload = (await response.json()) as { items?: Array<{ id: string; snippet?: { title?: string } }> };
      const item = payload.items?.[0];
      if (!item) throw new Error('YouTube account has no channel to connect');
      return { externalChannelId: item.id, externalChannelTitle: item.snippet?.title ?? null };
    },
  };
}
