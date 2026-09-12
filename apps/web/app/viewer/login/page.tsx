'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import { StatusMessage } from '../../components/StatusMessage';
import { useStatusMessage } from '../../hooks/useStatusMessage';
import { viewerLogin } from '../lib/viewer-api';

export default function ViewerLoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const { message, messageKind, notify } = useStatusMessage();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    try {
      await viewerLogin(email, password, 'BharatStudio web');
      window.location.assign('/viewer/dashboard');
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'Sign-in could not be completed', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="page-shell">
      <section className="auth-card" aria-labelledby="viewer-login-title">
        <p className="eyebrow">Supporter access</p>
        <h1 id="viewer-login-title">Sign in to your BharatStudio account.</h1>
        <p className="lede">This is your own supporter account, separate from any creator&rsquo;s BharatStudio dashboard.</p>
        <form onSubmit={(event) => void submit(event)}>
          <Field label="Email">
            <input type="email" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} />
          </Field>
          <Field label="Password">
            <input type="password" required autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </Field>
          <Button type="submit" variant="primary" disabled={submitting}>{submitting ? 'Signing in…' : 'Sign in'}</Button>
        </form>
        <StatusMessage message={message} kind={messageKind} />
        <p className="helper-text">
          <Link className="text-link" href="/viewer/forgot-password">Forgot your password?</Link>
        </p>
        <p className="helper-text">New here? <Link className="text-link" href="/viewer/signup">Create an account →</Link></p>
      </section>
    </main>
  );
}
