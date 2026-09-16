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
  // RT-02 §3.3. Unset means no additional admission limit — bounded only by
  // the platform's own Cloud Run request-concurrency cap. Never a value this
  // codebase invents; set only by deployment configuration.
  overlayMaxInstanceSubscribers?: number;
  overlayMaxChannelSubscribers?: number;
  // RT-10 §3.1 (FULL-PRODUCT-DEFINITION.md §19.0, §31.18.0). Unset means no
  // admission ceiling on widget/dashboard/analytics reads — every derived
  // read is admitted exactly as today, bounded only by the platform's own
  // Cloud Run request-concurrency cap. Never a value this codebase invents.
  derivedReadMaxConcurrent?: number;
  // RT-10 §3.1. Unset means widget/dashboard/analytics reads keep sharing
  // the main pool — no isolated pool is created.
  derivedReadPoolMax?: number;
  // RT-11 §3.1. Unset means no statement_timeout — today's behaviour,
  // unchanged. When set, validated against §19.4's own API-read budget
  // (p99 < 200ms) so a misconfiguration cannot kill compliant queries.
  derivedReadStatementTimeoutMs?: number;
  notificationTokenEncryptionKey?: string;
  publicPaymentTurnstileRequired?: boolean;
  publicPaymentTurnstileSecret?: string;
  sarvamApiKey?: string;
  sarvamTtsEndpoint?: string;
  resendApiKey?: string;
  resendFromAddress?: string;
  resendEndpoint?: string;
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

function parseAppOrigin(value: string, nodeEnv: RuntimeConfig['nodeEnv']): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('APP_ORIGIN must be an absolute HTTP(S) origin');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('APP_ORIGIN must use HTTP or HTTPS');
  }
  if (nodeEnv === 'staging' || nodeEnv === 'production') {
    if (url.protocol !== 'https:') throw new Error('APP_ORIGIN must use HTTPS in staging and production');
  }
  // CORS `Origin` values never contain a path, query, fragment, or userinfo.
  // Rejecting those configuration mistakes is safer than starting with a
  // credentialed allowlist that no legitimate browser request can match.
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('APP_ORIGIN must contain only scheme, host, and optional port');
  }
  return url.origin;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const rawNodeEnv = env.NODE_ENV ?? 'development';
  if (!allowedEnvironments.has(rawNodeEnv as RuntimeConfig['nodeEnv'])) {
    throw new Error('NODE_ENV must be development, test, staging, or production');
  }

  const nodeEnv = rawNodeEnv as RuntimeConfig['nodeEnv'];
  const appOriginRaw = env.APP_ORIGIN;
  if (!appOriginRaw) {
    throw new Error('APP_ORIGIN is required');
  }
  const appOrigin = parseAppOrigin(appOriginRaw, nodeEnv);

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
  const turnstileRequiredRaw = env.PUBLIC_PAYMENT_TURNSTILE_REQUIRED;
  if (turnstileRequiredRaw && turnstileRequiredRaw !== 'true' && turnstileRequiredRaw !== 'false') {
    throw new Error('PUBLIC_PAYMENT_TURNSTILE_REQUIRED must be true or false');
  }
  if (nodeEnv === 'production' && turnstileRequiredRaw === 'false') {
    throw new Error('PUBLIC_PAYMENT_TURNSTILE_REQUIRED cannot be disabled in production');
  }
  const publicPaymentTurnstileRequired = nodeEnv === 'production' || turnstileRequiredRaw === 'true';
  const publicPaymentTurnstileSecret = env.PUBLIC_PAYMENT_TURNSTILE_SECRET;
  if (publicPaymentTurnstileRequired && !publicPaymentTurnstileSecret) {
    throw new Error('PUBLIC_PAYMENT_TURNSTILE_SECRET is required when public payment Turnstile is required');
  }
  function optionalPositiveInt(name: string): number | undefined {
    const raw = env[name];
    if (raw === undefined || raw === '') return undefined;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error(`${name} must be a positive integer when set`);
    }
    return parsed;
  }
  const overlayMaxInstanceSubscribers = optionalPositiveInt('OVERLAY_MAX_INSTANCE_SUBSCRIBERS');
  const overlayMaxChannelSubscribers = optionalPositiveInt('OVERLAY_MAX_CHANNEL_SUBSCRIBERS');
  const derivedReadMaxConcurrent = optionalPositiveInt('WIDGET_ANALYTICS_MAX_CONCURRENT_READS');
  const derivedReadPoolMax = optionalPositiveInt('WIDGET_ANALYTICS_POOL_MAX');
  const derivedReadStatementTimeoutMs = optionalPositiveInt('WIDGET_ANALYTICS_STATEMENT_TIMEOUT_MS');
  // RT-11.4: a configured timeout below the path's own §19.4 budget would
  // cancel a query that is still within budget — reject it at startup
  // rather than silently degrading correctness for compliant reads. 200ms
  // is not invented here; it is §19.4's own stated "API p99 < 200ms for
  // reads" boundary, the same number `observability/metrics.ts`'s
  // `READ_DURATION_BUCKETS_MS` already uses as its RT-06 bucket boundary.
  const READ_PATH_BUDGET_MS = 200;
  if (derivedReadStatementTimeoutMs !== undefined && derivedReadStatementTimeoutMs < READ_PATH_BUDGET_MS) {
    throw new Error(`WIDGET_ANALYTICS_STATEMENT_TIMEOUT_MS must be at least ${READ_PATH_BUDGET_MS} (FULL-PRODUCT-DEFINITION.md §19.4 API read p99 budget) when set`);
  }

  const sarvamApiKey = env.SARVAM_API_KEY;
  const sarvamTtsEndpoint = env.SARVAM_TTS_ENDPOINT;
  if (sarvamTtsEndpoint) {
    try {
      if (new URL(sarvamTtsEndpoint).protocol !== 'https:') throw new Error('not https');
    } catch {
      throw new Error('SARVAM_TTS_ENDPOINT must be an HTTPS URL');
    }
  }
  const resendApiKey = env.RESEND_API_KEY;
  const resendFromAddress = env.RESEND_FROM_ADDRESS;
  const resendEndpoint = env.RESEND_ENDPOINT;
  if (resendEndpoint) {
    try {
      if (new URL(resendEndpoint).protocol !== 'https:') throw new Error('not https');
    } catch {
      throw new Error('RESEND_ENDPOINT must be an HTTPS URL');
    }
  }

  return {
    nodeEnv,
    host: env.HOST ?? '127.0.0.1',
    port,
    appOrigin,
    apiOrigin: env.API_ORIGIN ?? `http://127.0.0.1:${port}`,
    databaseUrlApp,
    databaseUrlDirect,
    overlayMaxInstanceSubscribers,
    overlayMaxChannelSubscribers,
    derivedReadMaxConcurrent,
    derivedReadPoolMax,
    derivedReadStatementTimeoutMs,
    googleClientId,
    paymentEnvironment,
    paymentServiceOrigin,
    paymentServiceAudience,
    internalServiceAudiences,
    notificationTokenEncryptionKey,
    publicPaymentTurnstileRequired,
    publicPaymentTurnstileSecret,
    sarvamApiKey,
    sarvamTtsEndpoint,
    resendApiKey,
    resendFromAddress,
    resendEndpoint,
  };
}
