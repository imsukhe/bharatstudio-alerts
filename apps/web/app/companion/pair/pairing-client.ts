/*
 * Client for the five companion-pairing endpoints
 * (apps/api/src/routes/companion-pairing.ts) that this page's confirmation
 * flow needs: GET .../:userCode, POST .../:userCode/approve and
 * POST .../:userCode/deny. Kept local to app/companion/pair rather than
 * added to ../../lib/api.ts — this lane owns only new files under
 * app/companion/pair/** — but deliberately reuses that module's existing
 * exports (getAccessToken, getApiOrigin) instead of re-deriving them.
 *
 * Every thrown error carries a `code` the page can switch on to pick a
 * human-facing message — never the server's raw errorCode/traceId.
 */
import { getAccessToken } from '../../lib/api';
import { getApiOrigin } from '../../lib/api-origin';

export type PairingClientType = 'desktop';
export type PairingState = 'pending' | 'approved' | 'denied' | 'expired' | 'consumed';

export type PairingRequestView = {
  schemaVersion: 'v1';
  userCode: string;
  clientType: PairingClientType;
  clientLabel: string;
  state: PairingState;
  createdAt: string;
  expiresAt: string;
};

export type PairingErrorCode = 'unauthenticated' | 'not_found' | 'forbidden' | 'invalid' | 'rate_limited' | 'unavailable' | 'network';

export class PairingApiError extends Error {
  code: PairingErrorCode;
  constructor(code: PairingErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

// The alphabet the desktop app's code is actually drawn from (migration
// 0082 / companion-pairing.ts's userCodePattern): 24 letters with I and O
// removed, digits 2-9 with 0 and 1 removed. No valid code ever contains
// 0, O, 1 or I.
const VALID_USER_CODE = /^[A-HJ-NP-Z2-9]{8}$/;

/*
 * Uppercases, strips spaces/dashes a creator might type between groups
 * (e.g. "abcd-2345"), then remaps a typed 0->O and 1->I before checking
 * the result against the real alphabet above. Because that alphabet
 * excludes O and I as well as 0 and 1, this remap can only ever turn an
 * already-invalid character into another already-invalid one — it never
 * turns a reject into an accept. It still runs, so a mistyped 0/1 fails
 * the *same* way a mistyped O/I does, with one consistent message,
 * instead of two different-looking rejections for what is, to the
 * person typing, the same mistake. Returns null for anything that isn't
 * exactly 8 characters of the real alphabet after normalising.
 */
export function normalizeUserCode(raw: string): string | null {
  const stripped = raw.toUpperCase().replace(/[\s-]/g, '');
  const remapped = stripped.replace(/0/g, 'O').replace(/1/g, 'I');
  return VALID_USER_CODE.test(remapped) ? remapped : null;
}

type Envelope = { schemaVersion?: unknown; errorCode?: unknown; message?: unknown };

function errorCodeForStatus(status: number): PairingErrorCode {
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status === 503) return 'unavailable';
  return 'invalid';
}

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  const token = getAccessToken();
  if (!token) throw new PairingApiError('unauthenticated', 'Sign in required.');
  let response: Response;
  try {
    response = await fetch(`${getApiOrigin()}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
      cache: 'no-store',
    });
  } catch {
    throw new PairingApiError('network', 'Could not reach the server.');
  }
  if (!response.ok) {
    let serverMessage = '';
    try {
      const body = (await response.json()) as Envelope;
      if (typeof body.message === 'string') serverMessage = body.message;
    } catch { /* non-JSON error body — fall back to the status-derived code below */ }
    throw new PairingApiError(errorCodeForStatus(response.status), serverMessage || `Request failed (${response.status})`);
  }
  if (response.status === 204) return undefined;
  try {
    return await response.json();
  } catch {
    throw new PairingApiError('invalid', 'Server response was invalid.');
  }
}

function parsePairingRequestView(value: unknown): PairingRequestView {
  if (
    typeof value !== 'object' || value === null ||
    (value as { schemaVersion?: unknown }).schemaVersion !== 'v1' ||
    typeof (value as { userCode?: unknown }).userCode !== 'string' ||
    (value as { clientType?: unknown }).clientType !== 'desktop' ||
    typeof (value as { clientLabel?: unknown }).clientLabel !== 'string' ||
    typeof (value as { state?: unknown }).state !== 'string' ||
    typeof (value as { createdAt?: unknown }).createdAt !== 'string' ||
    typeof (value as { expiresAt?: unknown }).expiresAt !== 'string'
  ) throw new PairingApiError('invalid', 'Server response was invalid.');
  return value as PairingRequestView;
}

export function fetchPairingRequest(userCode: string): Promise<PairingRequestView> {
  return request(`/v1/companion/pairing/${encodeURIComponent(userCode)}`).then(parsePairingRequestView);
}

export async function approvePairing(userCode: string, channelId: string): Promise<void> {
  await request(`/v1/companion/pairing/${encodeURIComponent(userCode)}/approve`, {
    method: 'POST',
    body: JSON.stringify({ channelId }),
  });
}

export async function denyPairing(userCode: string): Promise<void> {
  await request(`/v1/companion/pairing/${encodeURIComponent(userCode)}/deny`, { method: 'POST' });
}
