export type RuntimeConfig = {
  nodeEnv: 'development' | 'test' | 'staging' | 'production';
  host: string;
  port: number;
  appOrigin: string;
  apiOrigin?: string;
  databaseUrlApp?: string;
  databaseUrlDirect?: string;
  googleClientId?: string;
  paymentEnvironment?: 'test' | 'live';
  paymentServiceOrigin?: string;
  paymentServiceAudience?: string;
  internalServiceAudiences?: string[];
  overlayStreamWindowMs?: number;
  overlayPollMs?: number;
  notificationTokenEncryptionKey?: string;
};

const allowedEnvironments = new Set<RuntimeConfig['nodeEnv']>([
  'development',
  'test',
  'staging',
  'production',
]);

function isPostgresUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'postgres:' || url.protocol === 'postgresql:';
  } catch {
    return false;
  }
}

function isKnownPooledEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return hostname.includes('-pooler.')
      || hostname.startsWith('pooler.')
      || url.searchParams.get('pgbouncer')?.toLowerCase() === 'true';
  } catch {
    return false;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const rawNodeEnv = env.NODE_ENV ?? 'development';
  if (!allowedEnvironments.has(rawNodeEnv as RuntimeConfig['nodeEnv'])) {
    throw new Error('NODE_ENV must be development, test, staging, or production');
  }

  const nodeEnv = rawNodeEnv as RuntimeConfig['nodeEnv'];
  const appOrigin = env.APP_ORIGIN;
  if (!appOrigin) {
    throw new Error('APP_ORIGIN is required');
  }

  const port = Number(env.PORT ?? '4100');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535');
  }

  const databaseUrlApp = env.DATABASE_URL_APP;
  if ((nodeEnv === 'staging' || nodeEnv === 'production') && !databaseUrlApp) {
    throw new Error('DATABASE_URL_APP is required in staging and production');
  }
  const databaseUrlDirect = env.DATABASE_URL_DIRECT;
  if ((nodeEnv === 'staging' || nodeEnv === 'production') && !databaseUrlDirect) {
    throw new Error('DATABASE_URL_DIRECT is required in staging and production');
  }
  if ((nodeEnv === 'staging' || nodeEnv === 'production') && databaseUrlApp && databaseUrlDirect && databaseUrlApp === databaseUrlDirect) {
    throw new Error('DATABASE_URL_DIRECT must be a separate direct database endpoint');
  }
  if ((nodeEnv === 'staging' || nodeEnv === 'production') && databaseUrlApp && !isPostgresUrl(databaseUrlApp)) {
    throw new Error('DATABASE_URL_APP must be a PostgreSQL URL in staging and production');
  }
  if ((nodeEnv === 'staging' || nodeEnv === 'production') && databaseUrlDirect && !isPostgresUrl(databaseUrlDirect)) {
    throw new Error('DATABASE_URL_DIRECT must be a PostgreSQL URL in staging and production');
  }
  if ((nodeEnv === 'staging' || nodeEnv === 'production') && databaseUrlDirect && isKnownPooledEndpoint(databaseUrlDirect)) {
    throw new Error('DATABASE_URL_DIRECT must use a non-pooled database endpoint in staging and production');
  }

  const googleClientId = env.GOOGLE_CLIENT_ID;
  if ((nodeEnv === 'staging' || nodeEnv === 'production') && !googleClientId) {
    throw new Error('GOOGLE_CLIENT_ID is required in staging and production');
  }

  const paymentEnvironment = env.PAYMENT_ENVIRONMENT ?? (nodeEnv === 'production' ? 'live' : 'test');
  if (paymentEnvironment !== 'test' && paymentEnvironment !== 'live') {
    throw new Error('PAYMENT_ENVIRONMENT must be test or live');
  }
  const paymentServiceOrigin = env.PAYMENT_SERVICE_ORIGIN;
  const paymentServiceAudience = env.PAYMENT_SERVICE_AUDIENCE;
  if ((nodeEnv === 'staging' || nodeEnv === 'production') && (!paymentServiceOrigin || !paymentServiceAudience)) {
    throw new Error('PAYMENT_SERVICE_ORIGIN and PAYMENT_SERVICE_AUDIENCE are required in staging and production');
  }
  const internalServiceAudiences = (env.INTERNAL_SERVICE_AUDIENCES ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if ((nodeEnv === 'staging' || nodeEnv === 'production') && internalServiceAudiences.length === 0) {
    throw new Error('INTERNAL_SERVICE_AUDIENCES is required in staging and production');
  }
  const notificationTokenEncryptionKey = env.NOTIFICATION_TOKEN_ENCRYPTION_KEY;
  if ((nodeEnv === 'staging' || nodeEnv === 'production') && !notificationTokenEncryptionKey) {
    throw new Error('NOTIFICATION_TOKEN_ENCRYPTION_KEY is required in staging and production');
  }
  if (notificationTokenEncryptionKey && !/^[0-9a-fA-F]{64}$/.test(notificationTokenEncryptionKey)) {
    throw new Error('NOTIFICATION_TOKEN_ENCRYPTION_KEY must be 64 hexadecimal characters');
  }

  return {
    nodeEnv,
    host: env.HOST ?? '127.0.0.1',
    port,
    appOrigin,
    apiOrigin: env.API_ORIGIN ?? `http://127.0.0.1:${port}`,
    databaseUrlApp,
    databaseUrlDirect,
    googleClientId,
    paymentEnvironment,
    paymentServiceOrigin,
    paymentServiceAudience,
    internalServiceAudiences,
    notificationTokenEncryptionKey,
  };
}
