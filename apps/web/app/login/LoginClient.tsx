'use client';

import { useEffect, useState } from 'react';
import Script from 'next/script';
import { exchangeGoogleCredential, getTermsStatus } from '../lib/api';

type GoogleButton = { render: (element: HTMLElement, options: { theme: string; size: string; width: number }) => void };
type GoogleAccounts = { id: { initialize: (options: { client_id: string; callback: (response: { credential: string }) => void }) => void; renderButton: GoogleButton['render'] } };

export default function LoginClient() {
  const [ready, setReady] = useState(false);
  const [scriptReady, setScriptReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

  useEffect(() => {
    const google = (window as Window & { google?: { accounts?: GoogleAccounts } }).google;
    if (!google?.accounts || !clientId) return;
    google.accounts.id.initialize({
      client_id: clientId,
      callback: async ({ credential }) => {
        setError(null);
        try {
          await exchangeGoogleCredential(credential);
          // Route through the terms gate rather than assuming /dashboard —
          // the backend fails closed on mutations until every active
          // document is accepted (requireAuthAndTerms), so a returning or
          // newly-created account must accept first.
          let destination = '/dashboard';
          try {
            const status = await getTermsStatus();
            if (!status.accepted) destination = '/accept-terms';
          } catch {
            // Terms status is unreachable — fail toward showing the gate
            // rather than silently skipping it.
            destination = '/accept-terms';
          }
          window.location.assign(destination);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : 'Sign-in could not be completed');
        }
      },
    });
    const target = document.getElementById('google-sign-in');
    if (target) google.accounts.id.renderButton(target, { theme: 'filled_black', size: 'large', width: 360 });
    setReady(true);
  }, [clientId, scriptReady]);

  return (
    <>
      <Script src="https://accounts.google.com/gsi/client" strategy="afterInteractive" onLoad={() => setScriptReady(true)} />
      <div id="google-sign-in" aria-label="Continue with Google" />
      {!clientId && <p className="helper-text">Google sign-in is unavailable until the approved client configuration is provided.</p>}
      {clientId && !ready && <p className="helper-text">Loading secure sign-in…</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
    </>
  );
}
