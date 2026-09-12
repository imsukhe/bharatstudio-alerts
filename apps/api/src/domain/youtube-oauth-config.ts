// Config convention mirrors apps/api/src/config.ts's loadConfig (env-var
// driven, thrown Error on missing/invalid values) without expanding the
// general RuntimeConfig type. The production entrypoint loads this optional
// provider configuration and composes the OAuth client when all values exist.
//
// No real Google client ID/secret/token is ever hardcoded here or anywhere
// else in this lane's code — every value below comes from the environment.
export type YoutubeOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
  authorizationEndpoint: string;
  tokenEndpoint: string;
};

const DEFAULT_SCOPES = ['https://www.googleapis.com/auth/youtube.readonly'];
const DEFAULT_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const DEFAULT_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export function loadYoutubeOAuthConfig(env: NodeJS.ProcessEnv = process.env): YoutubeOAuthConfig | undefined {
  const clientId = env.YOUTUBE_OAUTH_CLIENT_ID;
  const clientSecret = env.YOUTUBE_OAUTH_CLIENT_SECRET;
  const redirectUri = env.YOUTUBE_OAUTH_REDIRECT_URI;
  if (!clientId && !clientSecret && !redirectUri) return undefined;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('YOUTUBE_OAUTH_CLIENT_ID, YOUTUBE_OAUTH_CLIENT_SECRET and YOUTUBE_OAUTH_REDIRECT_URI must all be set together');
  }
  const scopes = env.YOUTUBE_OAUTH_SCOPES ? env.YOUTUBE_OAUTH_SCOPES.split(',').map((value) => value.trim()).filter(Boolean) : DEFAULT_SCOPES;
  return {
    clientId,
    clientSecret,
    redirectUri,
    scopes,
    authorizationEndpoint: env.YOUTUBE_OAUTH_AUTHORIZATION_ENDPOINT ?? DEFAULT_AUTHORIZATION_ENDPOINT,
    tokenEndpoint: env.YOUTUBE_OAUTH_TOKEN_ENDPOINT ?? DEFAULT_TOKEN_ENDPOINT,
  };
}
