'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '../../components/AppShell';
import { authGateStates } from '../../components/AuthGateStates';
import { getChannel, getCurrentUser, getHistory, moderateAlert, type AlertHistory, type ChannelDetails } from '../../lib/api';

// Alerts' queue rows already map their raw states to friendly capitalized
// words (Paused/Ready/Closed) instead of showing the backend enum verbatim
// — history status gets the same treatment here for consistency. No
// underscores appear in these values today, so this is capitalization only.
function historyStatusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export default function ModConsolePage() {
  const [channel, setChannel] = useState<ChannelDetails | null>(null);
  const [history, setHistory] = useState<AlertHistory[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [messageKind, setMessageKind] = useState<'success' | 'error'>('success');
  const [error, setError] = useState<string | null>(null);
  // Replaces window.prompt() for the moderation-reason capture — a native
  // browser dialog broke the app's entire dark visual system for this one
  // action and gave zero feedback on cancel. Tracks which row (if any) has
  // its reason form open.
  const [pendingModeration, setPendingModeration] = useState<{ eventId: string; action: 'hold' | 'suppress' | 'replay' } | null>(null);
  const [reasonText, setReasonText] = useState('');
  const [moderating, setModerating] = useState(false);

  useEffect(() => {
    getCurrentUser().then(async (user) => {
      const first = user.channels[0];
      if (!first) { window.location.assign('/onboarding'); return; }
      const [nextChannel, nextHistory] = await Promise.all([getChannel(first.channelId), getHistory(first.channelId)]);
      setChannel(nextChannel); setHistory(nextHistory.items);
    }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Account data is unavailable'));
  }, []);

  const canModerateAlerts = channel ? ['owner', 'admin', 'operator', 'moderator'].includes(channel.role ?? '') : false;

  async function moderate(eventId: string, action: 'approve' | 'hold' | 'suppress' | 'replay', reason?: string) {
    if (!channel) return;
    setModerating(true);
    try {
      await moderateAlert(channel.channelId, eventId, action, reason);
      setMessage(`Alert ${action} action recorded.`);
      setMessageKind('success');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Moderation action could not be recorded');
      setMessageKind('error');
    } finally {
      setModerating(false);
      setPendingModeration(null);
      setReasonText('');
    }
  }

  function startModeration(eventId: string, action: 'hold' | 'suppress' | 'replay') {
    setPendingModeration({ eventId, action });
    setReasonText('');
  }

  function confirmModeration() {
    if (!pendingModeration) return;
    void moderate(pendingModeration.eventId, pendingModeration.action, reasonText.trim() || undefined);
  }

  if (error) return authGateStates({ title: 'Mod console', error, ready: true });
  if (!channel) return authGateStates({ title: 'Mod console', error: null, ready: false });

  return (
    <AppShell title="Mod console">
      {message && (messageKind === 'error'
        ? <p className="inline-message error-text" role="alert">{message}</p>
        : <p className="inline-message" role="status">{message}</p>)}
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
                      <button className="secondary-button" type="button" onClick={() => void moderate(item.eventId, 'approve')} disabled={moderating}>Approve</button>
                      <button className="secondary-button" type="button" onClick={() => startModeration(item.eventId, 'hold')} disabled={moderating || pendingModeration !== null}>Hold</button>
                      <button className="secondary-button" type="button" onClick={() => startModeration(item.eventId, 'suppress')} disabled={moderating || pendingModeration !== null}>Suppress</button>
                      <button className="secondary-button" type="button" onClick={() => startModeration(item.eventId, 'replay')} disabled={moderating || pendingModeration !== null}>Replay</button>
                    </div>
                  )}
                  {pendingModeration?.eventId === item.eventId && (
                    <div className="billing-confirm">
                      <label htmlFor={`mod-reason-${item.eventId}`} className="helper-text">
                        Reason for &quot;{pendingModeration.action}&quot; (kept in the audit trail, optional)
                      </label>
                      <input
                        id={`mod-reason-${item.eventId}`}
                        maxLength={500}
                        value={reasonText}
                        onChange={(event) => setReasonText(event.target.value)}
                        autoFocus
                      />
                      <div className="control-actions">
                        <button type="button" className="primary-button" onClick={confirmModeration} disabled={moderating}>
                          {moderating ? 'Recording…' : `Confirm ${pendingModeration.action}`}
                        </button>
                        <button type="button" className="secondary-button" onClick={() => { setPendingModeration(null); setReasonText(''); }} disabled={moderating}>Cancel</button>
                      </div>
                    </div>
                  )}
                </div>
                <span>{historyStatusLabel(item.status)}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </AppShell>
  );
}
