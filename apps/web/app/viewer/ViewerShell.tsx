'use client';

/*
 * The chrome around every viewer page. Deliberately NOT AppShell/TopNav —
 * both are creator chrome: AppShell fetches the creator's own channel/tier
 * via getCurrentUser()/getBilling() (the creator session), and TopNav reads
 * the creator's sessionStorage token to decide "Sign in"/"Sign out" and
 * links to /dashboard, /companion etc. A viewer is not a creator (see this
 * batch's own boundary) — rendering either here would show a signed-in
 * viewer as "Sign in" (wrong token namespace) or offer creator-only
 * destinations that instantly 403 for a viewer token. This nav only ever
 * reads/clears the viewer token and only ever links to /viewer/* routes.
 */
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { clearViewerAccessToken, getViewerAccessToken, viewerLogout } from './lib/viewer-api';

export function ViewerShell({ title, children }: { title: string; children: React.ReactNode }) {
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    setSignedIn(getViewerAccessToken() !== null);
  }, []);

  function signOut() {
    void viewerLogout().catch(() => clearViewerAccessToken());
    window.location.assign('/viewer/login');
  }

  return (
    <main className="page-shell">
      <nav className="top-nav" aria-label="Viewer navigation">
        <Link className="brand" href="/viewer/dashboard">Bharat<span className="brand-accent">Studio</span> <span className="muted-label">Viewer</span></Link>
        <div className="nav-links">
          <Link href="/viewer/search">Search profiles</Link>
          {signedIn ? (
            <>
              <Link href="/viewer/dashboard">Dashboard</Link>
              <Link href="/viewer/profile">Profile</Link>
              <Link href="/viewer/sessions">Sessions</Link>
              <button type="button" className="nav-action nav-action-button" onClick={signOut}>Sign out</button>
            </>
          ) : (
            <Link className="nav-action" href="/viewer/login">Sign in</Link>
          )}
        </div>
      </nav>
      <h1>{title}</h1>
      {children}
    </main>
  );
}
