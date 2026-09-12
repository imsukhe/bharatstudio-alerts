'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import { StatusMessage } from '../../components/StatusMessage';
import { useStatusMessage } from '../../hooks/useStatusMessage';
import { requestViewerPasswordReset } from '../lib/viewer-api';

export default function ViewerForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const { message, messageKind, notify } = useStatusMessage();

  // Deliberately unconditional: the request never reveals whether `email`
  // matched an account (see routes/viewer.ts's own comment) — this form
  // shows the same confirmation state whether the API call resolves or, in
  // the rare case the network/API itself is unavailable, rejects. There is
  // nothing in the response worth branching the UI on.
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    try {
      const result = await requestViewerPasswordReset(email);
      notify(result.message, 'success');
    } catch {
      notify('If that email is registered, a reset link has been sent', 'success');
    } finally {
      setSubmitting(false);
      setSent(true);
    }
  }

  return (
    <main className="page-shell">
      <section className="auth-card" aria-labelledby="viewer-forgot-title">
        <p className="eyebrow">Supporter access</p>
        <h1 id="viewer-forgot-title">Reset your password.</h1>
        <p className="lede">Enter the email on your account. If it matches one, we&rsquo;ll send a reset link — the confirmation below looks the same either way, so it never reveals whether an email is registered.</p>
        {!sent && (
          <form onSubmit={(event) => void submit(event)}>
            <Field label="Email">
              <input type="email" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} />
            </Field>
            <Button type="submit" variant="primary" disabled={submitting}>{submitting ? 'Sending…' : 'Send reset link'}</Button>
          </form>
        )}
        <StatusMessage message={message} kind={messageKind} />
        <p className="helper-text"><Link className="text-link" href="/viewer/login">Back to sign in →</Link></p>
      </section>
    </main>
  );
}
