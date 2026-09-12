'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import { StatusMessage } from '../../components/StatusMessage';
import { useStatusMessage } from '../../hooks/useStatusMessage';
import { viewerSignup } from '../lib/viewer-api';

export default function ViewerSignupPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const { message, messageKind, notify } = useStatusMessage();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    try {
      await viewerSignup(email, password, 'BharatStudio web', displayName.trim() || undefined);
      window.location.assign('/viewer/dashboard');
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'Could not create your account', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="page-shell">
      <section className="auth-card" aria-labelledby="viewer-signup-title">
        <p className="eyebrow">Supporter account</p>
        <h1 id="viewer-signup-title">Create your BharatStudio account.</h1>
        <p className="lede">Track your support across every creator you back — one private history, one login. This is separate from a creator&rsquo;s BharatStudio account.</p>
        <form onSubmit={(event) => void submit(event)}>
          <Field label="Email">
            <input type="email" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} />
          </Field>
          <Field label="Password (min. 8 characters)">
            <input type="password" required minLength={8} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </Field>
          <Field label="Display name (optional)">
            <input type="text" maxLength={80} autoComplete="nickname" value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          </Field>
          <Button type="submit" variant="primary" disabled={submitting}>{submitting ? 'Creating account…' : 'Create account'}</Button>
        </form>
        <StatusMessage message={message} kind={messageKind} />
        <p className="helper-text">Already have an account? <Link className="text-link" href="/viewer/login">Sign in →</Link></p>
      </section>
    </main>
  );
}
