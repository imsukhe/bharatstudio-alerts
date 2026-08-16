/*
 * Pure onboarding-resume decision, shared by every place that needs it
 * (the bare /onboarding redirector, step-1's own guard, step-2's own
 * guard, AppShell's gate, and LoginClient's post-sign-in routing) so there
 * is exactly one definition of "is this account done with setup" — not
 * five inline copies that could quietly drift from each other.
 *
 * Two gates, both derived from real, already-persisted account state
 * rather than a stored step counter:
 *   - Channel creation: `channels.length > 0`. Nothing to fall out of
 *     sync, and it is what makes "sign out mid-setup, sign back in, land
 *     on the same step" correct in every case without extra schema — see
 *     onboarding/OnboardingShell.tsx's header comment.
 *   - Payout onboarding: `channels[0].payoutOnboardingDone`, set true by
 *     the API once the channel has either a registered payment account or
 *     an explicit "Skip for now" recorded (migration
 *     0079_v1_l03_payout_onboarding_gate.sql) — added after the owner
 *     confirmed dashboard access should require finishing or explicitly
 *     skipping this step, not just creating a channel. The "explicitly
 *     skipped" state has to be persisted server-side, unlike channel
 *     existence: without it, "hasn't reached this step yet" and
 *     "skipped it" look identical (no payment account either way), and a
 *     returning creator who skipped would be sent back to this screen
 *     forever.
 */
export type OnboardingAwareUser = { channels: ReadonlyArray<{ channelId: string; payoutOnboardingDone: boolean }> };

export function hasCompletedOnboarding(user: OnboardingAwareUser): boolean {
  return user.channels.length > 0;
}

// Only meaningful once hasCompletedOnboarding(user) is true — a user with
// no channel yet hasn't reached this step at all, which is a different
// state from having finished or skipped it. Callers needing that
// distinction should check hasCompletedOnboarding first;
// resolvePostAuthDestination below already does.
export function hasCompletedPayoutOnboarding(user: OnboardingAwareUser): boolean {
  return user.channels[0]?.payoutOnboardingDone ?? false;
}

export function resolvePostAuthDestination(user: OnboardingAwareUser): '/dashboard' | '/onboarding/step-1' | '/onboarding/step-2' {
  if (!hasCompletedOnboarding(user)) return '/onboarding/step-1';
  if (!hasCompletedPayoutOnboarding(user)) return '/onboarding/step-2';
  return '/dashboard';
}
