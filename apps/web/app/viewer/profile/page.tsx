'use client';

import { useState } from 'react';
import { Card } from '../../components/ui/Card';
import { ViewerShell } from '../ViewerShell';
import { setViewerProfileVisibility } from '../lib/viewer-api';

export default function ViewerProfilePage() {
  const [visibility, setVisibility] = useState<'private' | 'public'>('private');
  const [slug, setSlug] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedSlug = slug.trim().toLowerCase();
    if (visibility === 'public' && trimmedSlug.length < 3) {
      setError('Choose a public link of at least 3 characters.');
      return;
    }
    setSaving(true); setError(null); setMessage(null);
    try {
      const saved = await setViewerProfileVisibility(visibility, visibility === 'public' ? trimmedSlug : null);
      setVisibility(saved.visibility); setSlug(saved.slug ?? '');
      setMessage(saved.visibility === 'public' ? `Your profile is public at /viewer/profiles/${saved.slug}` : 'Your profile is private and no longer appears in public search.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update profile visibility');
    } finally { setSaving(false); }
  }

  return <ViewerShell title="Your public profile.">
    <Card eyebrow="Optional" title="Profile visibility" helper="Your support amounts, payments, and receipts are never public. By default, your profile is private.">
      <form onSubmit={save} className="stack-form">
        <label><input type="radio" name="visibility" checked={visibility === 'private'} onChange={() => setVisibility('private')} /> Keep my profile private</label>
        <label><input type="radio" name="visibility" checked={visibility === 'public'} onChange={() => setVisibility('public')} /> Let people find my display name and profile link</label>
        {visibility === 'public' && <label>Public link<input aria-label="Public profile link" value={slug} maxLength={60} onChange={(event) => setSlug(event.target.value)} placeholder="ravi" /></label>}
        {error && <p className="error-text" role="alert">{error}</p>}
        {message && <p className="success-text" role="status">{message}</p>}
        <button className="button-primary" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save visibility'}</button>
      </form>
    </Card>
  </ViewerShell>;
}
