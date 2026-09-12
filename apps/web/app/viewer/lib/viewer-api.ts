/*
 * Viewer-surface API client. Deliberately separate from ../../lib/api.ts:
 * a viewer account is a SEPARATE auth surface from the creator account (see
 * packages/db/migrations/0084's header comment), with its own token
 * namespace, its own /v1/viewer/* routes, and its own response shapes. This
 * file only imports the one shared, surface-agnostic helper (getApiOrigin)
 * — nothing creator-specific (getAccessToken/apiFetch/getCurrentUser etc.
 * all read the CREATOR session and must never be reused here).
 */
import { getApiOrigin } from '../../lib/api-origin';

export type ViewerSession = { accessToken: string; expiresAt: string };
export type ViewerSessionSummary = {
  sessionId: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  deviceLabel: string | null;
  current: boolean;
};
export type ViewerDashboardRow = {
  channelId: string;
  channelHandle: string;
  channelDisplayName: string;
  firstSupportedAt: string;
  lastSupportedAt: string;
  lifetimeAmountPaise: string;
  tipCount: string;
  challengeCount: string;
  memberState: 'none' | 'active' | 'lapsed';
};
export type ViewerDeletionResult = { erased: string[]; retained: string[]; legalDispositionOpen: true };
export type ViewerProfileVisibility = { visibility: 'private' | 'public'; slug: string | null };

const VIEWER_TOKEN_KEY = 'bharatstudio.alerts.viewer.session';

export function getViewerAccessToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.sessionStorage.getItem(VIEWER_TOKEN_KEY);
}

export function storeViewerAccessToken(token: string): void {
  window.sessionStorage.setItem(VIEWER_TOKEN_KEY, token);
}

export function clearViewerAccessToken(): void {
  window.sessionStorage.removeItem(VIEWER_TOKEN_KEY);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isDateTime(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isDecimalString(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]+$/.test(value);
}

function isStringList(value: unknown, maxItems: number, maxLength: number): value is string[] {
  return Array.isArray(value) && value.length <= maxItems && value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= maxLength);
}

function isViewerDashboardRow(value: unknown): value is ViewerDashboardRow {
  if (!isRecord(value) || !hasExactKeys(value, ['channelId', 'channelHandle', 'channelDisplayName', 'firstSupportedAt', 'lastSupportedAt', 'lifetimeAmountPaise', 'tipCount', 'challengeCount', 'memberState'])) return false;
  return isUuid(value.channelId)
    && typeof value.channelHandle === 'string' && value.channelHandle.length > 0 && value.channelHandle.length <= 64
    && typeof value.channelDisplayName === 'string' && value.channelDisplayName.length > 0 && value.channelDisplayName.length <= 120
    && isDateTime(value.firstSupportedAt) && isDateTime(value.lastSupportedAt)
    && isDecimalString(value.lifetimeAmountPaise) && isDecimalString(value.tipCount) && isDecimalString(value.challengeCount)
    && (value.memberState === 'none' || value.memberState === 'active' || value.memberState === 'lapsed');
}

function isViewerSessionSummary(value: unknown): value is ViewerSessionSummary {
  if (!isRecord(value) || !hasExactKeys(value, ['sessionId', 'createdAt', 'lastSeenAt', 'expiresAt', 'deviceLabel', 'current'])) return false;
  return isUuid(value.sessionId) && isDateTime(value.createdAt) && isDateTime(value.lastSeenAt) && isDateTime(value.expiresAt)
    && (value.deviceLabel === null || typeof value.deviceLabel === 'string' && value.deviceLabel.length <= 80)
    && typeof value.current === 'boolean';
}

async function describeFailure(response: Response, fallback: string): Promise<string> {
  if (response.status === 401) return 'Please sign in again';
  if (response.status === 429) return 'Too many attempts — please wait a moment and try again';
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === 'string' && body.message.length > 0 && body.message.length <= 200) return body.message;
  } catch {
    /* keep fallback for a non-JSON body */
  }
  return fallback;
}

async function viewerFetch(path: string, init: RequestInit = {}, requireAuth = true): Promise<Record<string, unknown>> {
  const token = requireAuth ? getViewerAccessToken() : null;
  if (requireAuth && !token) throw new Error('Please sign in again');
  const response = await fetch(`${getApiOrigin()}${path}`, {
    ...init,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(await describeFailure(response, 'Request could not be completed'));
  if (response.status === 204) return {};
  try {
    const body = await response.json();
    if (!isRecord(body)) throw new Error();
    return body;
  } catch {
    throw new Error('Server response was invalid');
  }
}

function parseSession(body: Record<string, unknown>): ViewerSession {
  if (typeof body.accessToken !== 'string' || body.accessToken.length < 32 || typeof body.expiresAt !== 'string') {
    throw new Error('Server response was invalid');
  }
  return { accessToken: body.accessToken, expiresAt: body.expiresAt };
}

export async function viewerSignup(email: string, password: string, deviceLabel: string, displayName?: string): Promise<ViewerSession> {
  const session = parseSession(
    await viewerFetch('/v1/viewer/signup', { method: 'POST', body: JSON.stringify({ email, password, deviceLabel, ...(displayName ? { displayName } : {}) }) }, false),
  );
  storeViewerAccessToken(session.accessToken);
  return session;
}

export async function viewerLogin(email: string, password: string, deviceLabel: string): Promise<ViewerSession> {
  const session = parseSession(
    await viewerFetch('/v1/viewer/login', { method: 'POST', body: JSON.stringify({ email, password, deviceLabel }) }, false),
  );
  storeViewerAccessToken(session.accessToken);
  return session;
}

export async function viewerLogout(): Promise<void> {
  try {
    await viewerFetch('/v1/viewer/logout', { method: 'POST' });
  } finally {
    clearViewerAccessToken();
  }
}

export async function requestViewerPasswordReset(email: string): Promise<{ message: string }> {
  // Always resolves with the same generic message, matching the API's own
  // enumeration-resistant response — this function must never be changed
  // to branch on whether the email existed.
  const body = await viewerFetch('/v1/viewer/password/forgot', { method: 'POST', body: JSON.stringify({ email }) }, false);
  return { message: typeof body.message === 'string' ? body.message : 'If that email is registered, a reset link has been sent' };
}

export async function resetViewerPassword(token: string, newPassword: string): Promise<{ message: string }> {
  const body = await viewerFetch('/v1/viewer/password/reset', { method: 'POST', body: JSON.stringify({ token, newPassword }) }, false);
  return { message: typeof body.message === 'string' ? body.message : 'Your password has been reset' };
}

export async function getViewerDashboard(): Promise<ViewerDashboardRow[]> {
  const body = await viewerFetch('/v1/viewer/dashboard');
  const rows = body.supportedChannels;
  if (body.schemaVersion !== 'v1' || !Array.isArray(rows) || rows.length > 100 || !rows.every(isViewerDashboardRow)) throw new Error('Server response was invalid');
  return rows;
}

export async function getViewerSessions(): Promise<ViewerSessionSummary[]> {
  const body = await viewerFetch('/v1/viewer/sessions');
  const rows = body.sessions;
  if (body.schemaVersion !== 'v1' || !Array.isArray(rows) || rows.length > 100 || !rows.every(isViewerSessionSummary)) throw new Error('Server response was invalid');
  return rows;
}

export async function revokeViewerSession(sessionId: string): Promise<void> {
  await viewerFetch(`/v1/viewer/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
}

export async function requestViewerAccountDeletion(): Promise<ViewerDeletionResult> {
  const body = await viewerFetch('/v1/viewer/deletion-requests', { method: 'POST' });
  if (body.schemaVersion !== 'v1' || !isStringList(body.erased, 32, 160) || !isStringList(body.retained, 32, 160) || body.legalDispositionOpen !== true) throw new Error('Server response was invalid');
  return { erased: body.erased, retained: body.retained, legalDispositionOpen: true };
}

export async function setViewerProfileVisibility(visibility: 'private' | 'public', slug: string | null): Promise<ViewerProfileVisibility> {
  const body = await viewerFetch('/v1/viewer/profile-visibility', {
    method: 'PUT', body: JSON.stringify({ visibility, ...(slug ? { slug } : {}) }),
  });
  if (!hasExactKeys(body, ['schemaVersion', 'visibility', 'slug']) || body.schemaVersion !== 'v1'
    || (body.visibility !== 'private' && body.visibility !== 'public')
    || (body.slug !== null && (typeof body.slug !== 'string' || body.slug.length < 3 || body.slug.length > 60))
    || (body.visibility === 'public' && typeof body.slug !== 'string')
    || (body.visibility === 'private' && body.slug !== null)) {
    throw new Error('Server response was invalid');
  }
  return { visibility: body.visibility, slug: body.slug };
}

export async function searchPublicViewerProfiles(query: string): Promise<{ displayName: string | null; profileSlug: string }[]> {
  const body = await viewerFetch(`/v1/public/viewer-profiles?q=${encodeURIComponent(query)}`, {}, false);
  if (!Array.isArray(body.profiles)) throw new Error('Server response was invalid');
  const profiles = body.profiles.filter((profile): profile is Record<string, unknown> => isRecord(profile));
  if (profiles.length !== body.profiles.length || profiles.some((profile) => typeof profile.displayName !== 'string' && profile.displayName !== null || typeof profile.profileSlug !== 'string')) {
    throw new Error('Server response was invalid');
  }
  return profiles.map((profile) => ({ displayName: profile.displayName as string | null, profileSlug: profile.profileSlug as string }));
}

export async function getPublicViewerProfile(slug: string): Promise<{ displayName: string | null; profileSlug: string } | null> {
  const response = await fetch(`${getApiOrigin()}/v1/public/viewer-profiles/${encodeURIComponent(slug)}`, { cache: 'no-store' });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(await describeFailure(response, 'Profile is temporarily unavailable'));
  const body = await response.json() as Record<string, unknown>;
  if (!isRecord(body.profile) || (typeof body.profile.displayName !== 'string' && body.profile.displayName !== null) || typeof body.profile.profileSlug !== 'string') {
    throw new Error('Server response was invalid');
  }
  return { displayName: body.profile.displayName, profileSlug: body.profile.profileSlug };
}
