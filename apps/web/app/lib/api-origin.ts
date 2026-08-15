/**
 * Resolve the browser API origin without allowing a production build to
 * silently target a user's localhost. Development keeps the local default;
 * staging/production must provide an explicit HTTPS origin.
 */
export function getApiOrigin(
  configured = process.env.NEXT_PUBLIC_API_ORIGIN,
  nodeEnv: string = process.env.NODE_ENV,
): string {
  const raw = configured?.trim();
  if (!raw) {
    if (nodeEnv === 'development' || nodeEnv === 'test') return 'http://localhost:4100';
    throw new Error('api_origin_not_configured');
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('api_origin_invalid');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('api_origin_invalid');
  }
  if (parsed.username || parsed.password || (parsed.pathname !== '' && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    throw new Error('api_origin_invalid');
  }
  if (nodeEnv === 'staging' || nodeEnv === 'production') {
    if (parsed.protocol !== 'https:') throw new Error('api_origin_must_use_https');
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1') {
      throw new Error('api_origin_must_not_use_localhost');
    }
  }
  return parsed.origin;
}
