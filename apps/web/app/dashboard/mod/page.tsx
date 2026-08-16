'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AppShell } from '../../components/AppShell';
import { getChannel, getCurrentUser, getHistory, moderateAlert, type AlertHistory, type ChannelDetails } from '../../lib/api';

export default function ModConsolePage() {
  const [channel, setChannel] = useState<ChannelDetails | null>(null);
  const [history, setHistory] = useState<AlertHistory[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getCurrentUser().then(async (user) => {
      const first = user.channels[0];
      if (!first) { window.location.assign('/onboarding'); return; }
      const [nextChannel, nextHistory] = await Promise.all([getChannel(first.channelId), getHistory(first.channelId)]);
      setChannel(nextChannel); setHistory(nextHistory.items);
    }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Account data is unavailable'));
  }, []);

  const canModerateAlerts = channel ? ['owner', 'admin', 'operator', 'moderator'].includes(channel.role ?? '') : false;

  async function moderate(eventId: string, action: 'approve' | 'hold' | 'suppress' | 'replay') {
    if (!channel) return;
    let reason: string | undefined;
    if (action !== 'approve') {
      const entered = window.prompt(`Reason for "${action}" (kept in the audit trail):`);
      if (entered === null) return;
      reason = entered.trim() || undefined;
    }
    try {
      await moderateAlert(channel.channelId, eventId, action, reason);
      setMessage(`Alert ${action} action recorded.`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Moderation action could not be recorded');
    }
  }

  if (error) return <AppShell title="Mod console"><p className="error-text" role="alert">{error}</p><Link className="text-link" href="/login">Return to sign in →</Link></AppShell>;
  if (!channel) return <AppShell title="Mod console"><p className="helper-text" role="status">Loading…</p></AppShell>;

  return (
    <AppShell title="Mod console">
      {message && <p className="inline-message" role="status">{message}</p>}
      {!canModerateAlerts ? (
        <section className="panel"><p className="helper-text">Your channel role can view alert activity but cannot moderate it.</p></section>
      ) : null}
      <section className="panel" aria-labelledby="history-title">
        <div className="panel-heading"><div><p className="muted-label">History</p><h2 id="history-title">Recent alerts</h2></div><span className="helper-text">{history.length} loaded</span></div>
        {history.length === 0 ? <p>No alerts yet.</p> : (
          <div className="history-list">
            {history.map((item) => (
              <div className="history-row" key={item.eventId}>
                <div>
                  <strong>{item.displayName ?? item.sourceType}</strong>
                  <p>{item.message ?? 'No message'}</p>
                  {canModerateAlerts && (
                    <div className="control-actions">
                      <button className="secondary-button" type="button" onClick={() => moderate(item.eventId, 'approve')}>Approve</button>
                      <button className="secondary-button" type="button" onClick={() => moderate(item.eventId, 'hold')}>Hold</button>
                      <button className="secondary-button" type="button" onClick={() => moderate(item.eventId, 'suppress')}>Suppress</button>
                      <button className="secondary-button" type="button" onClick={() => moderate(item.eventId, 'replay')}>Replay</button>
                    </div>
                  )}
                </div>
                <span>{item.status}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </AppShell>
  );
}
