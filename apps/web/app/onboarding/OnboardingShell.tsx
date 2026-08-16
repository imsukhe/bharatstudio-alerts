'use client';

/*
 * Shared chrome for the onboarding wizard — minimal top bar (logo + step
 * progress) and centered content, deliberately with no sidebar/product
 * nav (ported from legacy's onboarding/layout.tsx: setup is a focused,
 * single-task flow, not a place to go exploring the rest of the app).
 *
 * Three steps, matching legacy's step count, and all three resume from
 * real account state rather than a stored "current step" counter — there
 * is nothing to fall out of sync:
 *   - Step 1 (accept terms) lives at the existing /accept-terms route,
 *     not under /onboarding/step-*  — every place that already redirects
 *     an unaccepted account there (LoginClient, DashboardClient, the
 *     terms-status-unreachable fail-closed path) keeps working unchanged.
 *     Gated on GET /v1/me/terms/status's `accepted` flag.
 *   - Step 2 (create channel) IS the onboarding gate proper: no channel
 *     yet == step 2, in every case, including "signed out mid-step and
 *     signed back in" — apps/web/app/onboarding/page.tsx and step-1/
 *     page.tsx (its URL kept as step-1 — see the header comment there for
 *     why) both redirect off the same `channels.length === 0` check the
 *     rest of the app already uses, so there is no separate flag that can
 *     drift.
 *   - Step 3 (connect payout) is optional and reachable only right after
 *     step 2 succeeds — it isn't gating, since payout can always be
 *     finished later from Settings, so it deliberately doesn't need a
 *     persisted "skipped" flag either.
 * Legacy's own step 1 (a stateless "your Google account is connected"
 * splash with nothing to submit) has no equivalent route here — it's
 * folded into the top of step 2's page instead, since a separate page for
 * it would need a "have they seen this already" flag with no real state
 * behind it, which is exactly the kind of thing that drifts.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const STEPS = [
  { path: '/accept-terms', label: 'Accept terms' },
  { path: '/onboarding/step-1', label: 'Create your channel' },
  { path: '/onboarding/step-2', label: 'Connect payout' },
];

export function OnboardingShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const currentIndex = Math.max(0, STEPS.findIndex((step) => step.path === pathname));

  return (
    <div className="onboarding-shell">
      <header className="onboarding-topbar">
        <Link href="/" className="brand">Bharat<span className="brand-accent">Studio</span></Link>
      </header>
      <div className="onboarding-progress" role="progressbar" aria-valuenow={currentIndex + 1} aria-valuemin={1} aria-valuemax={STEPS.length} aria-label={`Setup: step ${currentIndex + 1} of ${STEPS.length}`}>
        <div className="onboarding-progress-track">
          <div className="onboarding-progress-fill" style={{ width: `${(currentIndex / (STEPS.length - 1)) * 100}%` }} />
        </div>
        <ol className="onboarding-progress-dots" aria-hidden="true">
          {STEPS.map((step, index) => (
            <li key={step.path} className={index < currentIndex ? 'is-done' : index === currentIndex ? 'is-active' : undefined}>
              <span className="onboarding-dot">{index < currentIndex ? '✓' : index + 1}</span>
              <span className="onboarding-dot-label">{step.label}</span>
            </li>
          ))}
        </ol>
      </div>
      <main className="onboarding-content">{children}</main>
      <footer className="onboarding-footer">
        <p className="helper-text">Need help? <a href="mailto:support@bharatstudio.in">support@bharatstudio.in</a></p>
      </footer>
    </div>
  );
}
