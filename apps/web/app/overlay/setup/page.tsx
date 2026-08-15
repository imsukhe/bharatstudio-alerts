'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { createOverlaySession as createSession, getCurrentUser, revokeOverlaySession, rotateOverlaySession, type CurrentUser, type OverlaySession } from '../../lib/api';
import { TopNav } from '../../components/TopNav';

function formatExpiry(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

export default function OverlaySetupPage() {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [session, setSession] = useState<OverlaySession | null>(null);
  const [status, setStatus] = useState<string>('Loading your channel…');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    getCurrentUser().then((nextUser) => {
      setUser(nextUser);
      const requestedChannelId = new URLSearchParams(window.location.search).get('channelId');
      const selected = requestedChannelId && nextUser.channels.some((channel) => channel.channelId === requestedChannelId)
        ? requestedChannelId
        : nextUser.channels[0]?.channelId ?? null;
      setSelectedChannelId(selected);
      setStatus(selected ? 'Ready to create a session.' : 'Create a channel before creating an overlay session.');
    }).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : 'Account data is unavailable');
      setStatus('');
    });
  }, []);

  const channelId = selectedChannelId ?? user?.channels[0]?.channelId;

  async function create() {
    if (!channelId) return;
    setError(null); setCopied(false); setStatus('Creating a secure session…');
    try {
      setSession(await createSession(channelId));
      setStatus('Session created. Copy the URL into an OBS Browser Source.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Overlay session could not be created');
      setStatus('');
    }
  }

  async function rotate() {
    if (!session) return;
    setError(null); setCopied(false); setStatus('Rotating the session…');
    try {
      setSession(await rotateOverlaySession(session.overlayId));
      setStatus('Previous URL revoked. Copy the new URL into OBS.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Overlay session could not be rotated');
      setStatus('');
    }
  }

  async function revoke() {
    if (!session) return;
    setError(null); setStatus('Revoking the session…');
    try {
      await revokeOverlaySession(session.overlayId);
      setSession(null);
      setStatus('Session revoked. Create a new one when you are ready.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Overlay session could not be revoked');
      setStatus('');
    }
  }

  async function copyUrl() {
    if (!session) return;
    try {
      await navigator.clipboard.writeText(session.streamUrl);
      setCopied(true);
      setStatus('Copied. Treat this URL like a secret and do not publish it.');
    } catch {
      setError('Clipboard access was unavailable; copy the URL from the field.');
    }
  }

  return (
    <main className="page-shell">
      <TopNav />
      <section className="dashboard-heading compact-heading">
        <div>
          <p className="eyebrow">OBS browser source</p>
          <h1>A calm, secure path to your overlay.</h1>
          <p className="lede">Create a short-lived overlay session, copy its browser-source URL into OBS, and rotate it any time you need to.</p>
        </div>
      </section>
      {error && <p className="inline-message error-text" role="alert">{error}</p>}
      {status && <p className="inline-message" role="status">{status}</p>}
      <section className="setup-layout">
        <article className="panel setup-panel">
          <p className="muted-label">Setup checklist</p>
          {user && user.channels.length > 1 && <label htmlFor="overlay-channel">Channel<select id="overlay-channel" value={channelId ?? ''} onChange={(event) => { setSelectedChannelId(event.target.value); setSession(null); setCopied(false); setError(null); setStatus('Ready to create a session for the selected channel.'); }}><option value="" disabled>Select a channel</option>{user.channels.map((channel) => <option key={channel.channelId} value={channel.channelId}>{channel.channelId} · {channel.role}</option>)}</select></label>}
          <ol className="step-list">
            <li><span>01</span><div><strong>Sign in and select a channel</strong><p>Only a channel member with the required role can create a session.</p></div></li>
            <li><span>02</span><div><strong>Create overlay session</strong><p>The session is scoped, time-limited, revocable and stored by fingerprint—not as a raw token.</p></div></li>
            <li><span>03</span><div><strong>Add a Browser Source in OBS</strong><p>Use the generated URL and set the canvas size to match your selected design preview.</p></div></li>
            <li><span>04</span><div><strong>Test and rotate when needed</strong><p>Rotation revokes the previous session atomically.</p></div></li>
          </ol>
          {session && <div className="dashboard-form overlay-session-result">
            <label htmlFor="overlay-url">Browser Source URL</label>
            <input id="overlay-url" readOnly value={session.streamUrl} aria-describedby="overlay-expiry" />
            <p id="overlay-expiry" className="helper-text">Expires {formatExpiry(session.expiresAt)} · Overlay {session.overlayId}</p>
            <div className="control-actions"><button className="primary-button" type="button" onClick={copyUrl}>{copied ? 'Copied' : 'Copy URL'}</button><button className="secondary-button" type="button" onClick={rotate}>Rotate URL</button><button className="secondary-button" type="button" onClick={revoke}>Revoke</button></div>
          </div>}
        </article>
        <aside className="panel security-panel" aria-label="Overlay security information">
          <div className="status"><span className="dot" aria-hidden="true" /> Session controls</div>
          <h2>Never share a live overlay URL.</h2>
          <p>It grants display access to your channel’s overlay. Rotate it immediately if it appears in a public post or recording.</p>
          {!session && <button className="secondary-button" type="button" onClick={create} disabled={!channelId}>Create session</button>}
          <Link className="text-link" href="/dashboard">Return to dashboard →</Link>
        </aside>
      </section>
    </main>
  );
}
