// Referral links point new creators at /login?ref=<referrer-handle>. Google
// Identity Services signs the visitor in without a full-page redirect, but
// the eventual channel-creation step happens later on /dashboard, once the
// account exists and (if required) terms are accepted — a plain query
// param wouldn't survive that hop. localStorage does. The code is captured
// once at first sight and consumed (read + cleared) exactly once, at the
// point a channel is actually created, so a stale code never resurfaces on
// a later, unrelated channel creation.
const STORAGE_KEY = 'bharatstudio.alerts.referralCode';
const CODE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export function captureReferralCodeFromUrl(search: string): void {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(search);
  const code = params.get('ref');
  if (code && CODE_PATTERN.test(code)) {
    window.localStorage.setItem(STORAGE_KEY, code);
  }
}

export function consumeStoredReferralCode(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const code = window.localStorage.getItem(STORAGE_KEY);
  window.localStorage.removeItem(STORAGE_KEY);
  return code && CODE_PATTERN.test(code) ? code : undefined;
}
