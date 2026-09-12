'use client';

/*
 * Wraps the `getCurrentUser().then(...).catch(...)` bootstrap boilerplate
 * that was hand-copied near-identically across Alerts, Billing, Customise,
 * Mod, Referrals, Payments, Settings and DashboardClient.
 *
 * Deliberately narrow: it only replaces the repeated
 * `useEffect(() => { getCurrentUser().then(onUser).catch(onError) }, [])`
 * shell and the identical `cause instanceof Error ? cause.message : fallback`
 * ternary. Each call site keeps its own state (channel/config/queues/etc.),
 * its own "ready" derivation, its own no-channel redirect (or intentional
 * lack of one — Payments and Settings don't redirect), and its own
 * downstream effects (e.g. Payments' `setLoading(false)`). The auth-gate
 * branch is unchanged — call sites still call authGateStates themselves.
 */
import { useEffect } from 'react';
import { getCurrentUser, type CurrentUser } from '../lib/api';

/*
 * Plain (non-hook) form of the same fetch+catch, for the one call site
 * (DashboardClient) whose getCurrentUser() call is conditional — gated
 * behind a prior getTermsStatus() check — rather than unconditional on
 * mount. useChannelBootstrap below is this wrapped in the standard
 * `useEffect(..., [])` for every other call site.
 */
export function bootstrapChannelUser(
  onUser: (user: CurrentUser) => void | Promise<void>,
  onError: (message: string) => void,
  fallbackErrorMessage = 'Account data is unavailable',
) {
  return getCurrentUser()
    .then((user) => onUser(user))
    .catch((cause: unknown) => onError(cause instanceof Error ? cause.message : fallbackErrorMessage));
}

export function useChannelBootstrap(
  onUser: (user: CurrentUser) => void | Promise<void>,
  onError: (message: string) => void,
  fallbackErrorMessage = 'Account data is unavailable',
) {
  useEffect(() => {
    void bootstrapChannelUser(onUser, onError, fallbackErrorMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
