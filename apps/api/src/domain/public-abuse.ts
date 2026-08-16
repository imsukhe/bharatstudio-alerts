export interface PublicAbuseGuard {
  verify(token: string, remoteAddress?: string): Promise<boolean>;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function createTurnstileGuard(secret: string, fetcher: FetchLike = fetch): PublicAbuseGuard {
  const normalizedSecret = secret.trim();
  if (!normalizedSecret) throw new Error('Turnstile secret is required');
  return {
    async verify(token, remoteAddress) {
      const normalizedToken = token.trim();
      if (!normalizedToken || normalizedToken.length > 2048) return false;
      const form = new URLSearchParams({ secret: normalizedSecret, response: normalizedToken });
      if (remoteAddress && remoteAddress.length <= 128) form.set('remoteip', remoteAddress);
      try {
        const response = await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: form,
          signal: AbortSignal.timeout(3_000),
        });
        if (!response.ok) return false;
        const body = await response.json() as { success?: unknown };
        return body.success === true;
      } catch {
        return false;
      }
    },
  };
}
