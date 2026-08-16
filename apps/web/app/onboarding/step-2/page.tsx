'use client';

/*
 * Onboarding — connect a payout account. Visually step 3 of 3
 * (OnboardingShell counts /accept-terms as step 1, this URL's own
 * "step-1" sibling as step 2); URL kept as "step-2" for the same reason
 * step-1/page.tsx keeps its name — see that file's header comment.
 *
 * A real gate: dashboard access requires this step to be either finished
 * (a payment account registered) or explicitly skipped — owner-directed
 * change, 2026-08-16, after reaching the dashboard from a second tab
 * while sitting on this exact screen, having done neither. "Skip for now"
 * calls skipPayoutOnboarding, which records the skip server-side
 * (migration 0079_v1_l03_payout_onboarding_gate.sql) — without that call,
 * "hasn't gotten here yet" and "skipped it" would look identical (no
 * payment account either way) and a returning creator who skipped would
 * be sent back to this screen forever. Payout itself can still always be
 * finished later from Settings; only the wizard's own gate is affected.
 *
 * A channel existing here means terms were accepted at channel-creation
 * time (POST /v1/channels requires it server-side) — but they could have
 * lapsed since, if a new terms/privacy document version was published
 * after this creator's channel already existed. Checked directly rather
 * than assumed, same as step-1. Found via independent review.
 */
import { useEffect, useState } from 'react';
import { OnboardingShell } from '../OnboardingShell';
import { getAccessToken, getCurrentUser, getTermsStatus, registerPaymentAccount, skipPayoutOnboarding, type PaymentAccountEnvironment } from '../../lib/api';
import { hasCompletedOnboarding, hasCompletedPayoutOnboarding } from '../onboarding-routing';

export default function OnboardingStep2Page() {
  const [channelId, setChannelId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [environment, setEnvironment] = useState<PaymentAccountEnvironment>('test');
  const [connectedAccountRef, setConnectedAccountRef] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!getAccessToken()) { window.location.replace('/login'); return; }
    getTermsStatus()
      .then((status) => {
        if (!status.accepted) { window.location.replace('/accept-terms'); return; }
        getCurrentUser()
          .then((user) => {
            if (!hasCompletedOnboarding(user)) { window.location.replace('/onboarding/step-1'); return; }
            // Already finished or skipped (e.g. reached via back button,
            // or a stale bookmark) — nothing left to do here.
            if (hasCompletedPayoutOnboarding(user)) { window.location.replace('/dashboard'); return; }
            const first = user.channels[0];
            setChannelId(first!.channelId);
            setReady(true);
          })
          .catch(() => window.location.replace('/login'));
      })
      .catch(() => window.location.replace('/accept-terms'));
  }, []);

  async function handleConnect(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!channelId) return;
    setSubmitting(true);
    setError(null);
    try {
      await registerPaymentAccount(channelId, environment, connectedAccountRef.trim());
      window.location.assign('/dashboard');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Payout account could not be registered');
      setSubmitting(false);
    }
  }

  async function handleSkip() {
    if (!channelId || submitting) return;
    setSkipping(true);
    setError(null);
    try {
      await skipPayoutOnboarding(channelId);
      window.location.assign('/dashboard');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not skip this step. Please try again.');
      setSkipping(false);
    }
  }

  if (!ready) return <OnboardingShell><p className="helper-text" role="status">Loading…</p></OnboardingShell>;

  return (
    <OnboardingShell>
      <div className="onboarding-step">
        <h1>Connect your payout account.</h1>
        <p className="lede">
          Register the Razorpay connected-account reference issued by Razorpay&apos;s own partner onboarding.
          BharatStudio never holds your funds — tips route directly to this account. You can also do this later from Settings.
        </p>

        <form className="dashboard-form" onSubmit={handleConnect}>
          <label>
            Environment
            <select value={environment} onChange={(event) => setEnvironment(event.target.value as PaymentAccountEnvironment)}>
              <option value="test">Test</option>
              <option value="live">Live</option>
            </select>
            <small>Match this to the Razorpay account reference below — Test if it&apos;s from Razorpay&apos;s test mode, Live if it&apos;s a real payout account. Not related to whether this app itself is in development or production; you can register both and switch which one is active later from Settings.</small>
          </label>
          <label>
            Connected account reference
            <input
              required
              minLength={1}
              maxLength={128}
              pattern="[A-Za-z0-9._:-]+"
              value={connectedAccountRef}
              onChange={(event) => setConnectedAccountRef(event.target.value)}
              placeholder="acc_XXXXXXXXXXXXXX"
            />
          </label>
          {error && <p className="inline-message error-text" role="alert">{error}</p>}
          <div className="control-actions">
            <button className="primary-button" type="submit" disabled={submitting || skipping || !connectedAccountRef.trim()}>
              {submitting ? 'Connecting…' : 'Connect account'}
            </button>
            <button className="secondary-button" type="button" disabled={submitting || skipping} onClick={() => void handleSkip()}>
              {skipping ? 'Skipping…' : 'Skip for now — connect later'}
            </button>
          </div>
        </form>
      </div>
    </OnboardingShell>
  );
}
