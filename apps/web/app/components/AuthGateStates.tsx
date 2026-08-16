'use client';

/*
 * The "load current user/channel, fail closed on error, show Loading…
 * otherwise" preamble was hand-copied near-identically across Billing,
 * Referrals, Mod console and Alerts — same two-branch JSX, same classes,
 * same "Return to sign in →" link. Extracted once so a future fix to this
 * pattern (e.g. a copy change, an added retry action) only needs to happen
 * here. Purely additive: each call site's own AppShell title and readiness
 * check are unchanged, this just replaces the duplicated JSX with one call.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';
import { AppShell } from './AppShell';

export function authGateStates({ title, error, ready }: { title: string; error: string | null; ready: boolean }): ReactNode | null {
  if (error) {
    return (
      <AppShell title={title}>
        <p className="error-text" role="alert">{error}</p>
        <Link className="text-link" href="/login">Return to sign in →</Link>
      </AppShell>
    );
  }
  if (!ready) {
    return (
      <AppShell title={title}>
        <p className="helper-text" role="status">Loading…</p>
      </AppShell>
    );
  }
  return null;
}
