export type YoutubeConnectionStatus = 'pending' | 'active' | 'revoked';

export type YoutubeConnection = {
  schemaVersion: 'v1';
  connectionId: string;
  externalChannelId: string;
  externalChannelTitle: string | null;
  grantedScopes: string[];
  status: YoutubeConnectionStatus;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
};

export type YoutubeOAuthStateRecord = {
  channelId: string;
  userId: string;
  codeVerifier: string;
  redirectUri: string;
};

export type YoutubeFinalizeConnectionInput = {
  externalChannelId: string;
  externalChannelTitle: string | null;
  scopes: string[];
  // Raw (decrypted) token material as returned by Google's token endpoint.
  // The store is responsible for encrypting before it ever reaches SQL —
  // see apps/api/src/db/youtube-connection-store.ts.
  accessToken: string;
  refreshToken: string | null;
  tokenExpiresAt: string;
};

export interface YoutubeConnectionStore {
  list(userId: string, channelId: string): Promise<YoutubeConnection[]>;
  // Persists state + PKCE verifier for the OAuth callback to consume
  // exactly once. Raises on an unauthorized caller or an already-exhausted
  // connector entitlement (fail-fast; finalizeConnection re-checks
  // authoritatively).
  beginOAuth(
    userId: string,
    channelId: string,
    params: { state: string; codeVerifier: string; redirectUri: string },
  ): Promise<void>;
  // Single-use: raises if the state is unknown, expired, or already
  // consumed (covers both a forged/mismatched state and a replayed one).
  consumeOAuthState(state: string): Promise<YoutubeOAuthStateRecord>;
  // Reconnecting the same externalChannelId is a token refresh; a
  // distinct externalChannelId is only accepted under the channel's tier
  // connector entitlement.
  finalizeConnection(
    userId: string,
    channelId: string,
    input: YoutubeFinalizeConnectionInput,
  ): Promise<YoutubeConnection>;
  revoke(userId: string, channelId: string, connectionId: string): Promise<boolean>;
}
