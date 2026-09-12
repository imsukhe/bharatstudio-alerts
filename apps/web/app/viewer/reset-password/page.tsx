'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import { StatusMessage } from '../../components/StatusMessage';
import { useStatusMessage } from '../../hooks/useStatusMessage';
import { resetViewerPassword } from '../lib/viewer-api';

export default function ViewerResetPasswordPage() {
  // undefined = not yet read from the URL fragment; null = read, but no
  // token was present; a string = the token to submit.
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const { message, messageKind, notify } = useStatusMessage();

  useEffect(() => {
    // The reset link carries the token in the URL FRAGMENT, not a query
    // string (see db/viewer-reset-store.ts's resetUrl) — it is read here,
    // client-side, and never sent anywhere except this page's own POST
    // body, so it never reaches a server access log or a Referer header.
    const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
    const params = new URLSearchParams(hash);
    setToken(params.get('token'));
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!token) {
      notify('This reset link is missing its token', 'error');
      return;
    }
    setSubmitting(true);
    try {
      const result = await resetViewerPassword(token, password);
      notify(result.message, 'success');
      setDone(true);
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'This reset link is invalid or has expired', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="page-shell">
      <section className="auth-card" aria-labelledby="viewer-reset-title">
        <p className="eyebrow">Supporter access</p>
        <h1 id="viewer-reset-title">Choose a new password.</h1>
        {token === undefined && <p className="helper-text">Loading your reset link…</p>}
        {(token === null || token === '') && <p className="error-text" role="alert">This reset link is missing its token. Request a new one.</p>}
        {token && !done && (
          <form onSubmit={(event) => void submit(event)}>
            <Field label="New password (min. 8 characters)">
              <input type="password" required minLength={8} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} />
            </Field>
            <Button type="submit" variant="primary" disabled={submitting}>{submitting ? 'Resetting…' : 'Reset password'}</Button>
          </form>
        )}
        <StatusMessage message={message} kind={messageKind} />
        {done && <p className="helper-text">Every device you were signed in on has been signed out for security.</p>}
        <p className="helper-text">
          <Link className="text-link" href="/viewer/login">Back to sign in →</Link>
          {' · '}
          <Link className="text-link" href="/viewer/forgot-password">Request a new link →</Link>
        </p>
      </section>
    </main>
  );
}
