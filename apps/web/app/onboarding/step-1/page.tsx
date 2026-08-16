'use client';

/*
 * Onboarding — confirm account + create your channel. This is visually
 * step 2 of 3 (OnboardingShell's progress indicator counts /accept-terms
 * as step 1); the URL keeps the name "step-1" it already shipped with
 * rather than being renamed to "step-2", since nothing outside this app
 * depends on the URL and a rename here is pure churn for no behavior
 * change — the step LABEL a user sees is what OnboardingShell controls.
 *
 * This is the one real onboarding gate: apps/web/app/onboarding/page.tsx
 * (the bare /onboarding redirector), DashboardClient's own mount guard,
 * and this page's own guard below all derive "not onboarded yet" from the
 * exact same fact — `getCurrentUser().channels.length === 0` — so a user
 * who signs out here and signs back in always lands back on this page, in
 * every case, with no separate progress flag that could drift from it.
 * Terms acceptance (the real step 1) is a separate, earlier gate — see
 * /accept-terms/page.tsx — normally checked before a caller ever reaches
 * here, but this page also checks it directly rather than trusting that:
 * someone could reach this URL straight from a bookmark/typed address
 * without going through /onboarding's own redirector. Found via
 * independent review.
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { OnboardingShell } from '../OnboardingShell';
import { createChannel, getAccessToken, getCurrentUser, getTermsStatus, type CurrentUser } from '../../lib/api';
import { consumeStoredReferralCode } from '../../lib/referral-capture';
import { hasCompletedOnboarding, resolvePostAuthDestination } from '../onboarding-routing';

const HANDLE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export default function OnboardingStep1Page() {
  const router = useRouter();
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [handle, setHandle] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!getAccessToken()) { window.location.replace('/login'); return; }
    getTermsStatus()
      .then((status) => {
        if (!status.accepted) { window.location.replace('/accept-terms'); return; }
        getCurrentUser()
          .then((nextUser) => {
            // Channel already exists — resolve onward exactly like every
            // other entry point (could still be the payout step, not
            // necessarily the dashboard).
            if (hasCompletedOnboarding(nextUser)) { window.location.replace(resolvePostAuthDestination(nextUser)); return; }
            setUser(nextUser);
            setDisplayName(nextUser.displayName ?? '');
          })
          .catch(() => window.location.replace('/login'));
      })
      .catch(() => window.location.replace('/accept-terms'));
  }, []);

  async function handleCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await createChannel(handle.trim(), displayName.trim(), consumeStoredReferralCode());
      router.push('/onboarding/step-2');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Channel could not be created');
      setSubmitting(false);
    }
  }

  const handleValid = HANDLE_PATTERN.test(handle.trim());

  return (
    <OnboardingShell>
      <div className="onboarding-step">
        {user && (
          <div className="onboarding-identity-card">
            <span className="app-avatar" aria-hidden="true">{(user.displayName ?? 'B')[0]?.toUpperCase() ?? 'B'}</span>
            <div>
              <p className="onboarding-identity-name">{user.displayName ?? 'Your account'}</p>
              <p className="onboarding-identity-verified">
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M2 5l2 2 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                Google account connected
              </p>
            </div>
          </div>
        )}

        <h1>Create your channel.</h1>
        <p className="lede">
          Your handle becomes your public tip page — <span className="onboarding-url-preview">bharatstudio.in/tips/{handle.trim() || 'yourhandle'}</span>. Pick something your audience already recognises; it&apos;s permanent once set.
        </p>

        <form className="dashboard-form" onSubmit={handleCreate}>
          <label>
            Handle
            <input
              required
              minLength={1}
              maxLength={64}
              pattern="[A-Za-z0-9._-]+"
              value={handle}
              onChange={(event) => setHandle(event.target.value)}
              placeholder="your_handle"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          </label>
          <label>
            Display name
            <input
              required
              maxLength={120}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="Your channel name"
            />
          </label>
          {error && <p className="inline-message error-text" role="alert">{error}</p>}
          <button className="primary-button full-width" type="submit" disabled={submitting || !handleValid || !displayName.trim()}>
            {submitting ? 'Creating…' : 'Create channel →'}
          </button>
        </form>
      </div>
    </OnboardingShell>
  );
}
