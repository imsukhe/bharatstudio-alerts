'use client';

/*
 * /onboarding — resolves to the creator's current step from real account
 * state (no separate "onboarding_step" field to fall out of sync with):
 * no channel yet → step-1 (create channel — the one real gate); channel
 * already exists → onboarding is done, go straight to /dashboard.
 *
 * Terms is checked first, before the channel check — someone reaching this
 * URL directly (not through LoginClient, which already checks terms) with
 * zero channels but terms not yet accepted would otherwise land on
 * step-1's create-channel form and hit an unhelpful 403 on submit
 * (POST /v1/channels requires requireAuthAndTerms server-side). Found via
 * independent review — the original version of this file only checked
 * channel existence.
 */
import { useEffect } from 'react';
import { getAccessToken, getCurrentUser, getTermsStatus } from '../lib/api';
import { resolvePostAuthDestination } from './onboarding-routing';

export default function OnboardingIndexPage() {
  useEffect(() => {
    if (!getAccessToken()) { window.location.replace('/login'); return; }
    getTermsStatus()
      .then((status) => {
        if (!status.accepted) { window.location.replace('/accept-terms'); return; }
        getCurrentUser()
          .then((user) => window.location.replace(resolvePostAuthDestination(user)))
          .catch(() => window.location.replace('/login'));
      })
      .catch(() => window.location.replace('/accept-terms'));
  }, []);

  return null;
}
