import assert from 'node:assert/strict';
import test from 'node:test';
import { hasCompletedOnboarding, hasCompletedPayoutOnboarding, resolvePostAuthDestination } from './onboarding-routing';

test('an account with no channel yet has not completed onboarding', () => {
  assert.equal(hasCompletedOnboarding({ channels: [] }), false);
});

test('an account with a channel has completed onboarding, regardless of how many', () => {
  assert.equal(hasCompletedOnboarding({ channels: [{ channelId: 'a', payoutOnboardingDone: false }] }), true);
  assert.equal(hasCompletedOnboarding({ channels: [{ channelId: 'a', payoutOnboardingDone: false }, { channelId: 'b', payoutOnboardingDone: true }] }), true);
});

test('payout onboarding reads the first channel only, and defaults false for an account with no channel', () => {
  assert.equal(hasCompletedPayoutOnboarding({ channels: [] }), false);
  assert.equal(hasCompletedPayoutOnboarding({ channels: [{ channelId: 'a', payoutOnboardingDone: false }] }), false);
  assert.equal(hasCompletedPayoutOnboarding({ channels: [{ channelId: 'a', payoutOnboardingDone: true }] }), true);
});

test('post-auth routing sends a channel-less account to the create-channel step, not the dashboard', () => {
  assert.equal(resolvePostAuthDestination({ channels: [] }), '/onboarding/step-1');
});

test('post-auth routing sends an account with a channel but unfinished payout onboarding to the payout step, not the dashboard', () => {
  assert.equal(resolvePostAuthDestination({ channels: [{ channelId: 'a', payoutOnboardingDone: false }] }), '/onboarding/step-2');
});

test('post-auth routing sends a fully onboarded account straight to the dashboard, not back through setup', () => {
  assert.equal(resolvePostAuthDestination({ channels: [{ channelId: 'a', payoutOnboardingDone: true }] }), '/dashboard');
});

test('resume regression: a user who signs out while still on the create-channel step and signs back in lands on that same step every time — this is the literal acceptance case requested', () => {
  // The account state a "logged out mid-step-1" user has on their next
  // sign-in is indistinguishable from a brand-new account: authenticated,
  // zero channels. Both must resolve to the exact same step, in every
  // case — there is no separate "which step were they on" flag that could
  // give a different answer for one than the other.
  const freshSignup = { channels: [] as ReadonlyArray<{ channelId: string; payoutOnboardingDone: boolean }> };
  const returningIncompleteUser = { channels: [] as ReadonlyArray<{ channelId: string; payoutOnboardingDone: boolean }> };
  assert.equal(resolvePostAuthDestination(freshSignup), resolvePostAuthDestination(returningIncompleteUser));
  assert.equal(resolvePostAuthDestination(returningIncompleteUser), '/onboarding/step-1');
});

test('resume regression: a user who created a channel but never finished or skipped payout, signs out, and signs back in, lands on the payout step every time — not the dashboard', () => {
  // This is the exact scenario the owner reported: reaching the dashboard
  // from a second tab while still sitting on the payout step, having
  // neither connected an account nor clicked "Skip for now". Before the
  // payout gate existed, channel existence alone unlocked the dashboard;
  // now payoutOnboardingDone must also be true.
  const stillOnPayoutStep = { channels: [{ channelId: 'a', payoutOnboardingDone: false }] };
  assert.equal(resolvePostAuthDestination(stillOnPayoutStep), '/onboarding/step-2');
  // Signing out and back in changes nothing about that fact.
  const returningStillOnPayoutStep = { channels: [{ channelId: 'a', payoutOnboardingDone: false }] };
  assert.equal(resolvePostAuthDestination(returningStillOnPayoutStep), resolvePostAuthDestination(stillOnPayoutStep));
});

test('resume regression: a user who finished or explicitly skipped payout, signs out, and signs back in, never sees onboarding again', () => {
  const returningCompleteUser = { channels: [{ channelId: 'demo-channel', payoutOnboardingDone: true }] };
  assert.equal(resolvePostAuthDestination(returningCompleteUser), '/dashboard');
});
