'use client';

/*
 * Auth-aware primary nav. Two things this fixes:
 *
 *  - The "Sign in" action used to be a static link to /login regardless of
 *    whether a session token was already stored — a signed-in creator saw
 *    "Sign in" on every page. It now reads getAccessToken() (sessionStorage,
 *    synchronous — no network round trip) after mount and swaps to
 *    "Sign out". Server-rendered and first client render both show the
 *    signed-out state to avoid a hydration mismatch; the swap happens in
 *    the same paint as every other client-only auth check in this app
 *    (DashboardClient, CompanionPage, etc. all follow the same pattern).
 *  - `variant="minimal"` drops the product links (Dashboard/Companion/
 *    Overlay/Payments/Settings) entirely. Used on /accept-terms: every one
 *    of those destinations 403s until the terms gate is cleared
 *    (requireAuthAndTerms on the backend), so listing them there is a
 *    dead end dressed up as navigation.
 */
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { clearAccessToken, getAccessToken } from '../lib/api';

type Props = { variant?: 'full' | 'minimal' };

export function TopNav({ variant = 'full' }: Props) {
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    setSignedIn(getAccessToken() !== null);
  }, []);

  function signOut() {
    clearAccessToken();
    window.location.assign('/login');
  }

  return (
    <nav className="top-nav" aria-label="Primary navigation">
      <Link className="brand" href="/">Bharat<span className="brand-accent">Studio</span></Link>
      <div className="nav-links">
        {variant === 'full' && (
          <>
            <Link href="/dashboard">Dashboard</Link>
            <Link href="/companion">Companion</Link>
            <Link href="/overlay/setup">Overlay</Link>
            <Link href="/payments">Payments</Link>
            <Link href="/settings">Settings</Link>
          </>
        )}
        {signedIn ? (
          <button type="button" className="nav-action nav-action-button" onClick={signOut}>Sign out</button>
        ) : (
          <Link className="nav-action" href="/login">Sign in</Link>
        )}
      </div>
    </nav>
  );
}
