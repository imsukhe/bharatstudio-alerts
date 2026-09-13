// Razorpay OAuth (Technology Partner) connection — L19 task 3, "alongside
// the existing manual acc_XXX path; both supported, OAuth preferred".
//
// This is deliberately a THIN layer: it produces the values a manual
// connection already accepts (an environment + a connectedAccountRef), and
// hands them to the SAME account-connect call the manual path uses
// (CreatorPaymentProvider.connectAccount, backed by
// app_private.register_creator_payment_account, migration 0060) — see
// routes/payment-accounts.ts's oauth callback route. That is what "both
// supported... without code branching outside the provider abstraction"
// (this task's acceptance criteria) means in practice: OAuth only changes
// how a connectedAccountRef is obtained, never how it is stored or used
// downstream of connectAccount.
//
// Endpoints below are Razorpay's own publicly documented OAuth Partner
// endpoints (razorpay.com/docs/oauth/, auth.razorpay.com) — this file
// contains NO unconfirmed provider-policy claim of the kind
// governance/AGENTS.md:28 requires dated written evidence for (that rule
// targets Paytm/Cashfree/PhonePe's blocked rails, not Razorpay's already-
// public OAuth API shape). What IS unverified: the exact token-response
// field that carries the linked account id has not been exercised against
// a live Razorpay sandbox by this task — see the return report,
// "Remaining open". exchangeRazorpayOAuthCode's http client is injected
// for exactly that reason: it is fully unit-testable without a live call,
// and the real HTTP client is swapped in at the one call site outside this
// task's ownership (app.ts) once that verification happens.
const RAZORPAY_AUTHORIZE_URL = 'https://auth.razorpay.com/authorize';
const RAZORPAY_TOKEN_URL = 'https://auth.razorpay.com/token';

export type RazorpayOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export type RazorpayOAuthHttpClient = (url: string, body: Record<string, string>) => Promise<Record<string, unknown>>;

export function buildRazorpayAuthorizeUrl(config: RazorpayOAuthConfig, state: string): string {
  if (!state || state.length < 16) throw new Error('OAuth state must be a non-guessable value (>=16 chars)');
  const url = new URL(RAZORPAY_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', 'read_write');
  url.searchParams.set('state', state);
  return url.toString();
}

export type RazorpayOAuthLinkedAccount = {
  connectedAccountRef: string;
  environment: 'test' | 'live';
};

/**
 * Exchanges an OAuth authorization code for the linked Razorpay account id.
 * `httpClient` defaults to a real fetch against Razorpay's token endpoint
 * but is always overridable — every test in this task supplies a fake, so
 * no test performs a live network call.
 */
export async function exchangeRazorpayOAuthCode(
  config: RazorpayOAuthConfig,
  code: string,
  environment: 'test' | 'live',
  httpClient: RazorpayOAuthHttpClient = async (url, body) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });
    if (!response.ok) throw new Error(`Razorpay OAuth token exchange failed with status ${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  },
): Promise<RazorpayOAuthLinkedAccount> {
  if (!code || code.length < 1) throw new Error('OAuth code is required');
  const response = await httpClient(RAZORPAY_TOKEN_URL, {
    grant_type: 'authorization_code',
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
  });
  const connectedAccountRef = response.razorpay_account_id;
  if (typeof connectedAccountRef !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(connectedAccountRef)) {
    throw new Error('Razorpay OAuth token response did not carry a usable razorpay_account_id');
  }
  return { connectedAccountRef, environment };
}
