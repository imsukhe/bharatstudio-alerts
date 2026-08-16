'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { TopNav } from '../components/TopNav';
import { clearAccessToken, executeCompanionAction, getBilling, getCompanionLayout, getCompanionState, getCurrentUser, getHistory, getNotificationPreferences, getQueues, getSessions, notificationPreferencesInput, revokeSession, updateCompanionLayout, updateNotificationPreferences, type AccountSession, type AlertHistory, type BillingView, type CompanionAction, type CompanionLayout, type CompanionState, type CurrentUser, type NotificationPreferences, type Queue } from '../lib/api';

const operatorRoles = new Set(['owner', 'admin', 'operator']);
const actions: Array<{ action: CompanionAction; label: string; description: string }> = [
  { action: 'pause_queue', label: 'Pause queue', description: 'Hold new display activity while accepted records remain durable.' },
  { action: 'resume_queue', label: 'Resume queue', description: 'Allow ready deliveries to become visible again.' },
  { action: 'send_test_alert', label: 'Send test alert', description: 'Create a bounded synthetic alert for the selected channel.' },
];

function formatDate(value: string): string {
  return new Date(value).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

function formatAmount(paise: number | null): string {
  return paise === null ? 'Amount hidden' : `₹${(paise / 100).toLocaleString('en-IN')}`;
}

export default function CompanionPage() {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [state, setState] = useState<CompanionState | null>(null);
  const [layout, setLayout] = useState<CompanionLayout | null>(null);
  const [queues, setQueues] = useState<Queue[]>([]);
  const [history, setHistory] = useState<AlertHistory[]>([]);
  const [billing, setBilling] = useState<BillingView | null>(null);
  const [sessions, setSessions] = useState<AccountSession[]>([]);
  const [notificationPreferences, setNotificationPreferences] = useState<NotificationPreferences | null>(null);
  const [savingNotifications, setSavingNotifications] = useState(false);
  const [selectedQueueId, setSelectedQueueId] = useState<string | null>(null);
  const [message, setMessage] = useState('Loading authorised Companion state…');
  const [busy, setBusy] = useState<CompanionAction | null>(null);
  const [savingLayout, setSavingLayout] = useState(false);

  const channel = user?.channels.find(candidate => candidate.channelId === selectedChannelId);
  const selectedQueue = queues.find(queue => queue.queueId === selectedQueueId) ?? queues.find(queue => queue.active);
  const canOperate = Boolean(channel && operatorRoles.has(channel.role));
  const canTargetQueue = Boolean(selectedQueue?.active);

  useEffect(() => {
    let cancelled = false;
    async function loadUser() {
      try {
        const currentUser = await getCurrentUser();
        if (cancelled) return;
        setUser(currentUser);
        const selected = currentUser.channels[0];
        setSelectedChannelId(selected?.channelId ?? null);
        if (!selected) {
          setMessage('Create or join a channel before using Companion.');
        }
      } catch (cause) {
        if (cancelled) return;
        if (cause instanceof Error && /401|unauthor/i.test(cause.message)) clearAccessToken();
        setMessage(cause instanceof Error ? cause.message : 'Companion state could not be loaded.');
      }
    }
    void loadUser();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!selectedChannelId) return;
    const channelId = selectedChannelId;
    let cancelled = false;
    async function loadChannel() {
      try {
        const [nextState, nextQueues, nextLayout] = await Promise.all([getCompanionState(channelId), getQueues(channelId), getCompanionLayout(channelId)]);
        if (cancelled) return;
        setState(nextState);
        setLayout(nextLayout);
        setQueues(nextQueues.queues);
        setSelectedQueueId(previous => nextQueues.queues.some(queue => queue.queueId === previous && queue.active)
          ? previous
          : nextQueues.queues.find(queue => queue.active)?.queueId ?? null);
        const optional = await Promise.allSettled([getHistory(channelId), getBilling(channelId), getSessions(), getNotificationPreferences()]);
        if (cancelled) return;
        const [historyResult, billingResult, sessionsResult, notificationResult] = optional;
        if (historyResult.status === 'fulfilled') setHistory(historyResult.value.items);
        if (billingResult.status === 'fulfilled') setBilling(billingResult.value);
        if (sessionsResult.status === 'fulfilled') setSessions(sessionsResult.value.sessions);
        if (notificationResult.status === 'fulfilled') setNotificationPreferences(notificationResult.value);
        setMessage('Companion state is loaded from the server.');
      } catch (cause) {
        if (cancelled) return;
        setState(null);
        setQueues([]);
        setHistory([]);
        setBilling(null);
        setSessions([]);
        setNotificationPreferences(null);
        setSelectedQueueId(null);
        setMessage(cause instanceof Error ? cause.message : 'Companion state could not be loaded.');
      }
    }
    void loadChannel();
    return () => { cancelled = true; };
  }, [selectedChannelId]);

  async function runAction(action: CompanionAction) {
    if (!channel || !selectedQueue || !selectedQueue.active || busy) return;
    setBusy(action);
    setMessage('Sending an authorised Companion command…');
    try {
      await executeCompanionAction(channel.channelId, action, selectedQueue.queueId);
      const nextState = await getCompanionState(channel.channelId);
      setState(nextState);
      setMessage('Command accepted. Delivery and payment records remain independent of this control surface.');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Command could not be accepted.');
    } finally {
      setBusy(null);
    }
  }

  async function saveNotificationPreferences(next: Omit<NotificationPreferences, 'schemaVersion'>) {
    if (savingNotifications) return;
    setSavingNotifications(true);
    try {
      setNotificationPreferences(await updateNotificationPreferences(next));
      setMessage('Notification preferences saved on the server.');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Notification preferences could not be saved.');
    } finally {
      setSavingNotifications(false);
    }
  }

  async function closeSession(session: AccountSession) {
    if (session.current) return;
    setMessage('Revoking the selected account session…');
    try {
      await revokeSession(session.sessionId);
      setSessions(current => current.filter(candidate => candidate.sessionId !== session.sessionId));
      setMessage('Session revoked. Any cached client access must authenticate again.');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Session could not be revoked.');
    }
  }

  function addLayoutSlot(action: CompanionAction) {
    if (!layout || !selectedQueue || layout.slots.length >= layout.maxSlots) return;
    const slotIndex = Array.from({ length: layout.maxSlots }, (_, index) => index + 1).find(index => !layout.slots.some(slot => slot.slotIndex === index));
    if (!slotIndex) return;
    setLayout({ ...layout, slots: [...layout.slots, { slotIndex, page: Math.ceil(slotIndex / layout.pageSize), label: action === 'pause_queue' ? 'Pause queue' : action === 'resume_queue' ? 'Resume queue' : 'Test alert', action, targetId: selectedQueue.queueId }] });
  }

  function removeLayoutSlot(slotIndex: number) {
    if (!layout) return;
    setLayout({ ...layout, slots: layout.slots.filter(slot => slot.slotIndex !== slotIndex) });
  }

  async function saveLayout() {
    if (!layout || !canOperate || savingLayout) return;
    setSavingLayout(true);
    setMessage('Saving the server-authorised Companion layout…');
    try {
      const saved = await updateCompanionLayout(channel?.channelId ?? layout.channelId, layout.version, layout.pageSize, layout.slots);
      setLayout(saved);
      setMessage('Companion layout saved. Limits apply only to new control configuration.');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Companion layout could not be saved.');
    } finally {
      setSavingLayout(false);
    }
  }

  return (
    <main className="page-shell">
      <TopNav />
      <section className="dashboard-heading">
        <div>
          <p className="eyebrow">BharatStudio Companion</p>
          <h1>Broadcast context without broadcast risk.</h1>
          <p className="lede">A focused operational view for authorised channel members. Companion never connects this browser directly to OBS or changes financial truth.</p>
        </div>
        <Link className="secondary-button" href="/dashboard">Dashboard</Link>
      </section>

      <p className="helper-text" role="status">{message}</p>

      {user && user.channels.length > 1 && <section className="panel companion-selector" aria-labelledby="companion-channel-title">
        <div className="panel-heading"><div><p className="muted-label">Account channels</p><h2 id="companion-channel-title">Choose a channel</h2></div></div>
        <label>Authorised channel<select value={selectedChannelId ?? ''} onChange={(event) => setSelectedChannelId(event.target.value || null)}>
          {user.channels.map(candidate => <option key={candidate.channelId} value={candidate.channelId}>{candidate.channelId} · {candidate.role}</option>)}
        </select></label>
      </section>}

      <section className="metric-grid" aria-label="Companion state">
        <article className="metric-card"><p className="muted-label">Channel</p><strong>{channel?.channelId ?? '—'}</strong><p>{channel?.role ? `Role: ${channel.role}` : 'Sign in to load a channel.'}</p></article>
        <article className="metric-card"><p className="muted-label">Overlay</p><strong>{state?.overlayConnected ? 'Connected' : 'Not connected'}</strong><p>Connection state is read from the server.</p></article>
        <article className="metric-card"><p className="muted-label">Pending alerts</p><strong>{state?.pendingAlerts ?? '—'}</strong><p>Pending evidence is not removed by Companion limits.</p></article>
        <article className="metric-card"><p className="muted-label">Last server update</p><strong>{state?.lastUpdatedAt ? formatDate(state.lastUpdatedAt) : '—'}</strong><p>Stale state is shown as unavailable, never invented locally.</p></article>
      </section>

      <section className="content-grid">
        {layout && <article className="panel">
          <div className="panel-heading"><div><p className="muted-label">Server-owned controls</p><h2>Action layout</h2></div><span className="helper-text">{layout.slots.length}/{layout.maxSlots} slots</span></div>
          <p className="helper-text">{layout.tier} allocation · page size is 4, 8 or 16. Only approved queue actions can be added; this never limits accepted alerts or payments.</p>
          <label>Buttons per page<select value={layout.pageSize} onChange={(event) => { const pageSize = Number(event.target.value) as 4 | 8 | 16; setLayout({ ...layout, pageSize, slots: layout.slots.map(slot => ({ ...slot, page: Math.ceil(slot.slotIndex / pageSize) })) }); }} disabled={!canOperate || savingLayout}>
            {[4, 8, 16].filter(size => size <= layout.maxSlots).map(size => <option key={size} value={size}>{size}</option>)}
          </select></label>
          {canOperate && <div className="control-actions">
            {actions.map(({ action, label }) => <button className="secondary-button" key={`add-${action}`} type="button" disabled={!selectedQueue || layout.slots.length >= layout.maxSlots || savingLayout} onClick={() => addLayoutSlot(action)}>Add {label}</button>)}
            <button className="primary-button" type="button" disabled={savingLayout} onClick={() => void saveLayout()}>{savingLayout ? 'Saving…' : 'Save layout'}</button>
          </div>}
          {layout.slots.length === 0 ? <p className="helper-text">No custom slots saved. Add an approved action to build the Companion grid.</p> : <div className="queue-list">{layout.slots.map(slot => <div className="queue-row" key={slot.slotIndex}><div><strong>#{slot.slotIndex} · {slot.label}</strong><small>Page {slot.page} · {slot.action}</small></div>{canOperate && <button className="secondary-button" type="button" onClick={() => removeLayoutSlot(slot.slotIndex)} disabled={savingLayout}>Remove</button>}</div>)}</div>}
        </article>}
        <article className="panel">
          <div className="panel-heading"><div><p className="muted-label">Authorised controls</p><h2>Operate the queue</h2></div><span className="helper-text">{canOperate ? 'Operator access' : 'Read-only access'}</span></div>
          {canOperate && <label>Target queue<select value={selectedQueue?.queueId ?? ''} onChange={(event) => setSelectedQueueId(event.target.value || null)} disabled={queues.length === 0}>
            {queues.length === 0 && <option value="">No active queue loaded</option>}
            {queues.filter(queue => queue.active).map(queue => <option key={queue.queueId} value={queue.queueId}>{queue.name}{queue.paused ? ' · paused' : ''}</option>)}
          </select></label>}
          {!canOperate ? <p className="helper-text">Your channel role can view state but cannot issue queue commands.</p> : !canTargetQueue ? <p className="helper-text">Queue controls are disabled until an active queue is loaded.</p> : <div className="control-actions">{actions.map(({ action, label }) => <button className="secondary-button" key={action} type="button" disabled={busy !== null} onClick={() => void runAction(action)}>{busy === action ? 'Sending…' : label}</button>)}</div>}
          <p className="helper-text">Commands are finite, idempotent and server-authorised. There is no arbitrary local command or localhost OBS connection in this web surface.</p>
        </article>
        <article className="panel">
          <div className="panel-heading"><div><p className="muted-label">Queue state</p><h2>Destinations stay durable</h2></div><span className="helper-text">{queues.length} loaded</span></div>
          {queues.length === 0 ? <p>No queue is available for this channel.</p> : <div className="queue-list">{queues.map((queue) => <div className="queue-row" key={queue.queueId}><div><strong>{queue.name}</strong><small>{queue.paused ? 'Paused' : queue.active ? 'Ready' : 'Closed'}</small></div><span className="helper-text">{queue.queueId}</span></div>)}</div>}
        </article>
        <article className="panel" aria-labelledby="activity-title">
          <div className="panel-heading"><div><p className="muted-label">Recent activity</p><h2 id="activity-title">Alert history</h2></div><span className="helper-text">{history.length} loaded</span></div>
          {history.length === 0 ? <p className="helper-text">No recent activity is available for this channel.</p> : <div className="history-list">{history.slice(0, 10).map(item => <div className="history-row" key={item.eventId}><div><strong>{item.displayName ?? item.sourceType}</strong><p>{item.message ?? 'No message'} · {formatAmount(item.grossAmountPaise)}</p><small>{formatDate(item.createdAt)}</small></div><span>{item.status}</span></div>)}</div>}
          <p className="helper-text">History is server-projected and role-scoped. Companion limits do not delete or hide accepted payment evidence.</p>
        </article>
        <article className="panel" aria-labelledby="plan-title">
          <div className="panel-heading"><div><p className="muted-label">Entitlement state</p><h2 id="plan-title">Plan and feature access</h2></div><span className="helper-text">{billing?.tier ?? layout?.tier ?? '—'}</span></div>
          <div className="status-list"><div><strong>Action slots</strong><span>{layout ? `${layout.slots.length} / ${layout.maxSlots}` : 'Unavailable'}</span></div><div><strong>Page size</strong><span>{layout ? `${layout.pageSize} buttons` : 'Unavailable'}</span></div><div><strong>Billing</strong><span>{billing ? `${billing.billingInterval} · ${billing.renewalState}` : 'Unavailable'}</span></div></div>
          <p className="helper-text">The server owns plan limits. A locked feature is unavailable to this channel; it never changes delivery, payment receipt or queue durability.</p>
        </article>
        <article className="panel" aria-labelledby="session-title">
          <div className="panel-heading"><div><p className="muted-label">Account security</p><h2 id="session-title">Devices and sessions</h2></div><span className="helper-text">{sessions.length} active</span></div>
          {sessions.length === 0 ? <p className="helper-text">Session list is unavailable until the account projection loads.</p> : <div className="session-list">{sessions.map(session => <div className="session-row" key={session.sessionId}><div><strong>{session.deviceLabel ?? 'Unnamed device'}{session.current ? ' · current' : ''}</strong><small>Last seen {formatDate(session.lastSeenAt)}</small></div>{!session.current && <button className="secondary-button" type="button" onClick={() => void closeSession(session)}>Revoke</button>}</div>)}</div>}
          <p className="helper-text">Revocation is server-side and auditable. The current browser session cannot revoke itself from this control.</p>
        </article>
        <article className="panel" aria-labelledby="recovery-title">
          <div className="panel-heading"><div><p className="muted-label">Health and recovery</p><h2 id="recovery-title">Know what is safe to do next</h2></div></div>
          <div className="status-list"><div><strong>Overlay health</strong><span>{state?.overlayConnected ? 'Connected' : 'Not connected'}</span></div><div><strong>Delivery state</strong><span>{state ? `${state.pendingAlerts} pending` : 'Unavailable'}</span></div><div><strong>Notifications</strong><span>{notificationPreferences ? 'Configured' : 'Unavailable'}</span></div></div>
          {notificationPreferences && <div className="control-actions" aria-label="Notification preferences">
            {([['connectionAlerts', 'Connection changes'], ['securityAlerts', 'Security events'], ['actionFailures', 'Action failures']] as const).map(([key, label]) => <label key={key}><input type="checkbox" checked={notificationPreferences[key]} disabled={savingNotifications} onChange={(event) => void saveNotificationPreferences(notificationPreferencesInput({ ...notificationPreferences, [key]: event.target.checked }))} /> {label}</label>)}
          </div>}
          <details><summary>Recovery guidance</summary><p className="helper-text">If an overlay is disconnected, keep the browser source installed and reconnect it. Accepted alerts remain durable and replayable. If a session is unfamiliar, revoke it and sign in again. Companion never asks this browser to connect directly to OBS.</p></details>
        </article>
      </section>
    </main>
  );
}
