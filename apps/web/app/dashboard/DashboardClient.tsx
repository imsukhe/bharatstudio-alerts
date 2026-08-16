'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { clearAccessToken, createBinding, createChannel, createQueue, executeCompanionAction, getBilling, getBindings, getChannel, getChannelConfig, getCompanionState, getCurrentUser, getHistory, getQueues, getTermsStatus, moderateAlert, sendTestAlert, updateBinding, updateChannelConfig, updateQueue, type AlertHistory, type BillingView, type ChannelConfig, type ChannelConfigValues, type ChannelDetails, type CompanionAction, type CompanionState, type CurrentUser, type Queue, type QueueBinding } from '../lib/api';
import { ChannelConfigEditor } from './ChannelConfigEditor';
import { BillingActionsPanel } from './BillingActionsPanel';

const defaultConfig: ChannelConfigValues = {
  minimumTipPaise: 1000,
  defaultDisplaySeconds: 8,
  defaultStyle: 'standard_card',
  locale: 'en-IN',
  reducedMotion: false,
  brackets: [{ amountMinPaise: 1000, amountMaxPaise: null, charLimit: 120, ttsEligible: true, displayStyle: 'standard_card', displayMinMs: 8000, ttsOverflowPolicy: 'extend' }],
  tts: { enabled: false, language: 'en-IN', overflowPolicy: 'extend', paddingMs: 0 },
  display: { anchor: 'bottom_center', offsetX: 0, offsetY: 0, scale: 1, widthPercent: 80, maxVisibleItems: 1 },
  queue: { mode: 'fifo', stackLimit: 1, rateLimitPerMinute: 60, aggregationWindowSeconds: 30, aggregationThreshold: 5, approvalRequired: false, quietMode: { enabled: false, start: '23:00', end: '07:00', timezone: 'Asia/Kolkata' } },
};
const bindingsUiEnabled = process.env.NEXT_PUBLIC_ENABLE_BINDINGS_UI === 'true';

function formatPlanPrice(monthlyPricePaise: number): string {
  return monthlyPricePaise === 0 ? 'Free' : `₹${Math.round(monthlyPricePaise / 100).toLocaleString('en-IN')}/month`;
}

function mergeConfig(values: ChannelConfigValues): ChannelConfigValues {
  return {
    ...defaultConfig,
    ...values,
    display: { ...defaultConfig.display, ...values.display },
    queue: { ...defaultConfig.queue, ...values.queue },
    tts: { ...defaultConfig.tts, ...values.tts },
  };
}


export default function DashboardClient() {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [channel, setChannel] = useState<ChannelDetails | null>(null);
  const [queues, setQueues] = useState<Queue[]>([]);
  const [bindings, setBindings] = useState<QueueBinding[]>([]);
  const [history, setHistory] = useState<AlertHistory[]>([]);
  const [tier, setTier] = useState<string | null>(null);
  const [billing, setBilling] = useState<BillingView | null>(null);
  const [companion, setCompanion] = useState<CompanionState | null>(null);
  const [config, setConfig] = useState<ChannelConfig | null>(null);
  const [configDraft, setConfigDraft] = useState<ChannelConfigValues>(defaultConfig);
  const [savingConfig, setSavingConfig] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [channelForm, setChannelForm] = useState({ handle: '', displayName: '' });
  const [queueName, setQueueName] = useState('Main alerts');
  const [selectedCompanionQueueId, setSelectedCompanionQueueId] = useState<string | null>(null);
  const [testMessage, setTestMessage] = useState('Welcome to the stream!');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getTermsStatus().then((status) => {
      if (!status.accepted) { window.location.assign('/accept-terms'); return; }
      loadDashboard();
    }).catch(() => {
      // Terms status couldn't be confirmed — fail toward the gate rather
      // than silently rendering a dashboard whose mutations the backend
      // will reject.
      window.location.assign('/accept-terms');
    });

    function loadDashboard() {
      getCurrentUser().then(async (nextUser) => {
        setUser(nextUser);
        const first = nextUser.channels[0];
        if (!first) return;
        const [nextChannel, nextQueues, nextHistory, billing, companionState, nextConfig, nextBindings] = await Promise.all([getChannel(first.channelId), getQueues(first.channelId), getHistory(first.channelId), getBilling(first.channelId), getCompanionState(first.channelId), getChannelConfig(first.channelId), bindingsUiEnabled ? getBindings(first.channelId) : Promise.resolve({ schemaVersion: 'v1' as const, bindings: [] })]);
        setChannel(nextChannel); setQueues(nextQueues.queues); setSelectedCompanionQueueId(nextQueues.queues.find(queue => queue.active)?.queueId ?? null); setHistory(nextHistory.items); setTier(billing.tier); setBilling(billing); setCompanion(companionState); setConfig(nextConfig); setConfigDraft(mergeConfig(nextConfig.values));
        setBindings(nextBindings.bindings);
      }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Account data is unavailable'));
    }
  }, []);

  if (error) {
    return <div className="panel"><p className="error-text" role="alert">{error}</p><Link className="text-link" href="/login">Return to sign in →</Link></div>;
  }
  if (!user) return <div className="panel" role="status">Loading your channels…</div>;
  const currentUser = user;
  const canOperateQueues = channel ? ['owner', 'admin', 'operator'].includes(channel.role ?? '') : false;
  const canModerateAlerts = channel ? ['owner', 'admin', 'operator', 'moderator'].includes(channel.role ?? '') : false;
  // Billing carries financial amounts and payment-provider actions — scoped
  // to owner/admin only, matching the launch authority's role-scoped
  // financial-visibility rule (operator/moderator/viewer do not see this).
  const canManageBilling = channel ? ['owner', 'admin'].includes(channel.role ?? '') : false;

  async function submitChannel(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage(null);
    try { const next = await createChannel(channelForm.handle, channelForm.displayName); const nextConfig = await getChannelConfig(next.channelId); setChannel(next); setConfig(nextConfig); setConfigDraft(mergeConfig(nextConfig.values)); setUser({ ...currentUser, channels: [...currentUser.channels, { channelId: next.channelId, role: 'owner' }] }); setMessage('Channel created.'); }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Channel could not be created'); }
  }

  async function submitConfig(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!channel || !config) return;
    setSavingConfig(true); setMessage(null);
    try {
      const next = await updateChannelConfig(channel.channelId, config.version, configDraft);
      setConfig(next); setConfigDraft(mergeConfig(next.values)); setMessage('Alert configuration saved.');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Configuration could not be saved. Reload and try again.');
    } finally { setSavingConfig(false); }
  }

  async function submitQueue(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!channel) return;
    try { const next = await createQueue(channel.channelId, queueName); setQueues([...queues, next]); setQueueName(''); setMessage('Queue created.'); }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Queue could not be created'); }
  }

  async function submitTestAlert(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!channel) return;
    try { await sendTestAlert(channel.channelId, currentUser.displayName ?? 'Viewer', testMessage); setMessage('Test alert accepted and added to the durable alert path.'); }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Test alert could not be accepted'); }
  }

  async function toggleQueue(queue: Queue) {
    if (!channel) return;
    try {
      const next = await updateQueue(channel.channelId, queue.queueId, { paused: !queue.paused });
      setQueues(queues.map((candidate) => candidate.queueId === next.queueId ? next : candidate));
      if (!next.active || next.paused) {
        const fallback = queues.find(candidate => candidate.active && candidate.queueId !== next.queueId && !candidate.paused);
        setSelectedCompanionQueueId(fallback?.queueId ?? null);
      } else {
        setSelectedCompanionQueueId(next.queueId);
      }
      setMessage(`${next.name} is ${next.paused ? 'paused' : 'ready'}.`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Queue could not be updated');
    }
  }

  async function toggleBinding(binding: QueueBinding) {
    if (!channel) return;
    try {
      const next = await updateBinding(channel.channelId, binding.bindingId, { allowDuplicates: !binding.allowDuplicates });
      setBindings(bindings.map((candidate) => candidate.bindingId === next.bindingId ? next : candidate));
      setMessage(`Routing for ${next.sourceId === '__channel_default__' ? 'new payments' : next.sourceId} updated.`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Binding could not be updated');
    }
  }

  async function saveBinding(binding: QueueBinding, input: { priority: number; overrideValues: Record<string, unknown> | null }) {
    if (!channel) return;
    try {
      const next = await updateBinding(channel.channelId, binding.bindingId, input);
      setBindings(bindings.map((candidate) => candidate.bindingId === next.bindingId ? next : candidate));
      setMessage('Source routing settings saved for future events.');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Routing settings could not be saved');
    }
  }

  async function closeBinding(binding: QueueBinding) {
    if (!channel || binding.sourceId === '__channel_default__') return;
    try {
      const next = await updateBinding(channel.channelId, binding.bindingId, { active: false });
      setBindings(bindings.map((candidate) => candidate.bindingId === next.bindingId ? next : candidate));
      setMessage('Routing binding closed. Existing accepted deliveries are unchanged.');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Binding could not be closed');
    }
  }

  async function reopenBinding(binding: QueueBinding) {
    if (!channel) return;
    try {
      const next = await updateBinding(channel.channelId, binding.bindingId, { active: true });
      setBindings(bindings.map((candidate) => candidate.bindingId === next.bindingId ? next : candidate));
      setMessage('Routing binding reopened for future events.');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Binding could not be reopened');
    }
  }

  async function addBinding(input: { queueId: string; sourceType: QueueBinding['sourceType']; sourceId: string; allowDuplicates: boolean; priority: number }) {
    if (!channel) return;
    try {
      const next = await createBinding(channel.channelId, input);
      setBindings([next, ...bindings]);
      setMessage('Routing binding created for future events.');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Binding could not be created');
    }
  }

  async function moderate(eventId: string, action: 'approve' | 'hold' | 'suppress' | 'replay') {
    if (!channel) return;
    // Approve is a simple confirmation; hold/suppress/replay change what a
    // viewer sees or re-triggers delivery, so — matching legacy's required
    // rejection reason — collect a written reason for the audit trail
    // before recording those.
    let reason: string | undefined;
    if (action !== 'approve') {
      const entered = window.prompt(`Reason for "${action}" (kept in the audit trail):`);
      if (entered === null) return; // cancelled
      reason = entered.trim() || undefined;
    }
    try {
      await moderateAlert(channel.channelId, eventId, action, reason);
      setMessage(`Alert ${action} action recorded.`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Moderation action could not be recorded');
    }
  }

  async function sendCompanionAction(action: CompanionAction) {
    if (!channel) return;
    const target = queues.find(queue => queue.queueId === selectedCompanionQueueId && queue.active)
      ?? queues.find(queue => queue.active);
    if (!target) { setMessage('Companion controls are unavailable until an active queue is loaded.'); return; }
    try { await executeCompanionAction(channel.channelId, action, target.queueId); setMessage('Companion command accepted.'); }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Companion command could not be accepted'); }
  }

  return (
    <>
      <section className="panel welcome-panel">
        <p className="muted-label">Signed in</p>
        <h2>{user.displayName ? `Welcome, ${user.displayName}.` : 'Welcome to your dashboard.'}</h2>
        <p>Your account is connected through the reviewed authentication flow. Choose a channel to continue configuring Alerts.</p>
      </section>
      {message && <p className="inline-message" role="status">{message}</p>}
      {!channel ? <section className="panel" aria-labelledby="create-channel-title"><p className="muted-label">First step</p><h2 id="create-channel-title">Create your channel</h2><form className="dashboard-form" onSubmit={submitChannel}><label>Channel handle<input required minLength={1} maxLength={64} pattern="[A-Za-z0-9._-]+" value={channelForm.handle} onChange={(event) => setChannelForm({ ...channelForm, handle: event.target.value })} placeholder="your_handle" /></label><label>Display name<input required maxLength={120} value={channelForm.displayName} onChange={(event) => setChannelForm({ ...channelForm, displayName: event.target.value })} placeholder="Your channel name" /></label><button className="primary-button" type="submit">Create channel</button></form></section> : <>
        <section className="panel channel-overview"><div><p className="muted-label">Selected channel</p><h2>{channel.displayName}</h2><p className="handle">@{channel.handle} · {channel.acceptingTips ? 'Tips open' : 'Tips closed'} · {tier ?? 'Plan loading'}</p></div><Link className="primary-button" href={`/tips/${channel.handle}`}>Open public page</Link></section>
        {billing && <section className="panel" aria-labelledby="billing-title"><div className="panel-heading"><div><p className="muted-label">Billing</p><h2 id="billing-title">{billing.tier[0].toUpperCase() + billing.tier.slice(1)} · {formatPlanPrice(billing.monthlyPricePaise)}</h2></div><span className="helper-text">{billing.renewalState === 'not_applicable' ? 'No recurring subscription' : billing.renewalState.replace('_', ' ')}</span></div><p className="helper-text">{billing.billingInterval === 'annual' ? `${billing.annualMonthsCharged} months charged for ${billing.annualServiceMonths} months of service` : 'Monthly billing'} · {billing.autoRenew ? 'Auto-renew on' : 'Auto-renew off'}</p>{billing.priceSource === 'grandfathered' && billing.priceProtectedUntil ? <p className="helper-text">Protected price through {new Date(billing.priceProtectedUntil).toLocaleDateString('en-IN')} while the subscription remains eligible.</p> : null}{billing.renewalState === 'past_due' && billing.currentPeriodEndsAt ? <p className="helper-text">Payment attention required. Access follows the approved grace and dunning policy through {new Date(billing.currentPeriodEndsAt).toLocaleDateString('en-IN')}.</p> : null}{canManageBilling ? <BillingActionsPanel channelId={channel.channelId} billing={billing} onUpdated={(next) => { setBilling(next); setTier(next.tier); }} /> : <p className="helper-text">Only the channel owner or an admin can change the plan.</p>}</section>}
        {config && <ChannelConfigEditor version={config.version} draft={configDraft} saving={savingConfig} onChange={setConfigDraft} onSubmit={submitConfig} />}
        <section className="content-grid dashboard-controls"><article className="panel"><p className="muted-label">Queues</p><h2>Keep every alert accounted for.</h2><div className="queue-list">{queues.length === 0 ? <p>No queues yet.</p> : queues.map((queue) => <div className="queue-row" key={queue.queueId}><div><span>{queue.name}</span><small>{queue.paused ? 'Paused' : queue.active ? 'Ready' : 'Closed'}</small></div>{canOperateQueues && <button className="secondary-button" type="button" onClick={() => toggleQueue(queue)}>{queue.paused ? 'Resume' : 'Pause'}</button>}</div>)}</div>{canOperateQueues && <form className="inline-form" onSubmit={submitQueue}><input required maxLength={80} value={queueName} onChange={(event) => setQueueName(event.target.value)} placeholder="New queue name" /><button className="secondary-button" type="submit">Add queue</button></form>}</article><article className="panel"><p className="muted-label">Test alert</p><h2>Preview the delivery path</h2>{canOperateQueues ? <form className="dashboard-form" onSubmit={submitTestAlert}><label>Message<textarea required maxLength={500} rows={3} value={testMessage} onChange={(event) => setTestMessage(event.target.value)} /></label><button className="primary-button" type="submit">Send test alert</button></form> : <p className="helper-text">Your channel role can view the queue state but cannot send test alerts.</p>}</article></section>
        {bindingsUiEnabled && canOperateQueues && <BindingControls bindings={bindings} queues={queues} onCreate={addBinding} onSave={saveBinding} onToggle={toggleBinding} onClose={closeBinding} onReopen={reopenBinding} />}
        <section className="panel companion-panel"><div><p className="muted-label">Web Companion</p><h2>Broadcast controls</h2><p>{companion?.overlayConnected ? 'Overlay connected' : 'Overlay not connected'} · {companion?.pendingAlerts ?? 0} pending alerts</p></div>{canOperateQueues ? <><label>Target queue<select value={selectedCompanionQueueId ?? ''} onChange={(event) => setSelectedCompanionQueueId(event.target.value || null)}><option value="">Select an active queue</option>{queues.filter(queue => queue.active).map(queue => <option key={queue.queueId} value={queue.queueId}>{queue.name}{queue.paused ? ' · paused' : ''}</option>)}</select></label>{queues.some(queue => queue.active) ? <div className="control-actions"><button className="secondary-button" type="button" onClick={() => sendCompanionAction('pause_queue')}>Pause queue</button><button className="secondary-button" type="button" onClick={() => sendCompanionAction('resume_queue')}>Resume queue</button><button className="secondary-button" type="button" onClick={() => sendCompanionAction('send_test_alert')}>Send test</button></div> : <p className="helper-text">Controls are unavailable until an active queue is loaded.</p>}</> : <p className="helper-text">Your channel role can view Companion state but cannot issue broadcast controls.</p>}</section>
        <section className="panel"><div className="panel-heading"><div><p className="muted-label">History</p><h2>Recent alerts</h2></div><span className="helper-text">{history.length} loaded</span></div>{history.length === 0 ? <p>No alerts yet.</p> : <div className="history-list">{history.map((item) => <div className="history-row" key={item.eventId}><div><strong>{item.displayName ?? item.sourceType}</strong><p>{item.message ?? 'No message'}</p>{canModerateAlerts && <div className="control-actions"><button className="secondary-button" type="button" onClick={() => moderate(item.eventId, 'approve')}>Approve</button><button className="secondary-button" type="button" onClick={() => moderate(item.eventId, 'hold')}>Hold</button><button className="secondary-button" type="button" onClick={() => moderate(item.eventId, 'suppress')}>Suppress</button><button className="secondary-button" type="button" onClick={() => moderate(item.eventId, 'replay')}>Replay</button></div>}</div><span>{item.status}</span></div>)}</div>}</section>
      </>}
      <section className="panel channel-panel" aria-labelledby="channels-title">
        <div className="panel-heading"><div><p className="muted-label">Your channels</p><h2 id="channels-title">Channel access</h2></div><button className="secondary-button" type="button" onClick={() => { clearAccessToken(); window.location.assign('/login'); }}>Sign out</button></div>
        {user.channels.length === 0 ? <p>No channel is connected yet.</p> : <div className="channel-list">{user.channels.map((channel) => <div className="channel-row" key={channel.channelId}><div><strong>{channel.channelId}</strong><span>{channel.role}</span></div><Link className="text-link" href={`/overlay/setup?channelId=${encodeURIComponent(channel.channelId)}`}>Configure →</Link></div>)}</div>}
      </section>
    </>
  );
}

function BindingControls({ bindings, queues, onCreate, onSave, onToggle, onClose, onReopen }: { bindings: QueueBinding[]; queues: Queue[]; onCreate: (input: { queueId: string; sourceType: QueueBinding['sourceType']; sourceId: string; allowDuplicates: boolean; priority: number }) => void; onSave: (binding: QueueBinding, input: { priority: number; overrideValues: Record<string, unknown> | null }) => void; onToggle: (binding: QueueBinding) => void; onClose: (binding: QueueBinding) => void; onReopen: (binding: QueueBinding) => void }) {
  const queueNames = new Map(queues.map((queue) => [queue.queueId, queue.name]));
  const activeQueues = queues.filter((queue) => queue.active);
  const [queueId, setQueueId] = useState(activeQueues[0]?.queueId ?? '');
  const [sourceType, setSourceType] = useState<QueueBinding['sourceType']>('payment');
  const [sourceId, setSourceId] = useState('');
  const [allowDuplicates, setAllowDuplicates] = useState(false);
  const [priority, setPriority] = useState(0);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!queueId || !sourceId.trim()) return;
    onCreate({ queueId, sourceType, sourceId: sourceId.trim(), allowDuplicates, priority });
    setSourceId('');
  }

  return <section className="panel binding-panel" aria-labelledby="binding-controls-title">
    <div className="panel-heading"><div><p className="muted-label">Source routing</p><h2 id="binding-controls-title">Choose where each source appears</h2></div><span className="helper-text">Staging-gated</span></div>
    <p className="helper-text">The channel default route keeps new payments deliverable before a provider payment ID exists. Enabling duplicates on more than one active binding intentionally sends future matching events to each selected queue. Accepted deliveries already in progress keep their frozen route.</p>
    {bindings.length === 0 ? <p>No routing bindings are available.</p> : <div className="binding-list">{bindings.map((binding) => <div className={`binding-row${binding.active ? '' : ' is-closed'}`} key={binding.bindingId}>
      <div><strong>{binding.sourceId === '__channel_default__' ? 'New payments (default)' : binding.sourceId}</strong><small>{binding.sourceType} · {queueNames.get(binding.queueId) ?? 'Unknown queue'} · priority {binding.priority} · {binding.active ? 'Active' : 'Closed'}</small></div>
      <div className="control-actions">{binding.active && <button className="secondary-button" type="button" onClick={() => onToggle(binding)}>{binding.allowDuplicates ? 'Disable duplicate route' : 'Allow duplicate route'}</button>}{binding.active && binding.sourceId !== '__channel_default__' && <button className="secondary-button" type="button" onClick={() => onClose(binding)}>Close</button>}{!binding.active && <button className="secondary-button" type="button" onClick={() => onReopen(binding)}>Reopen</button>}</div>
      {binding.active && <BindingEditForm binding={binding} onSave={onSave} />}
    </div>)}</div>}
    <form className="binding-create-form" onSubmit={submit}>
      <p className="muted-label">Add a source binding</p>
      <div className="config-grid">
        <label>Queue<select required value={queueId} onChange={(event) => setQueueId(event.target.value)}>{activeQueues.map((queue) => <option key={queue.queueId} value={queue.queueId}>{queue.name}</option>)}</select></label>
        <label>Source type<select value={sourceType} onChange={(event) => setSourceType(event.target.value as QueueBinding['sourceType'])}><option value="payment">Payment</option><option value="manual">Manual</option><option value="companion">Companion</option></select></label>
        <label>Priority<input type="number" min="0" max="100000" value={priority} onChange={(event) => setPriority(Number(event.target.value))} /></label>
      </div>
      <label className="checkbox-label"><input type="checkbox" checked={allowDuplicates} onChange={(event) => setAllowDuplicates(event.target.checked)} /> Allow this source to route to another opted-in queue</label>
      <button className="secondary-button" type="submit" disabled={!queueId || !sourceId.trim()}>Add binding</button>
    </form>
  </section>;
}

const bindingStyles = ['small_pill', 'compact_card', 'standard_card', 'large_card', 'banner', 'celebration'] as const;
const bindingAnchors = ['top_left', 'top_center', 'top_right', 'center_left', 'center', 'center_right', 'bottom_left', 'bottom_center', 'bottom_right'] as const;

function BindingEditForm({ binding, onSave }: { binding: QueueBinding; onSave: (binding: QueueBinding, input: { priority: number; overrideValues: Record<string, unknown> | null }) => void }) {
  const current = binding.overrideValues ?? {};
  const [priority, setPriority] = useState(binding.priority);
  const [displayStyle, setDisplayStyle] = useState(typeof current.displayStyle === 'string' ? current.displayStyle : '');
  const [anchor, setAnchor] = useState(typeof current.anchor === 'string' ? current.anchor : '');
  const [scale, setScale] = useState(typeof current.scale === 'number' ? String(current.scale) : '');

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next: Record<string, unknown> = { ...current, displayStyle: displayStyle || undefined, anchor: anchor || undefined, scale: scale === '' ? undefined : Number(scale) };
    for (const key of ['displayStyle', 'anchor', 'scale']) if (next[key] === undefined) delete next[key];
    onSave(binding, { priority, overrideValues: Object.keys(next).length > 0 ? next : null });
  }

  return <form className="binding-edit-form" onSubmit={submit}>
    <label>Priority<input type="number" min="0" max="100000" value={priority} onChange={(event) => setPriority(Number(event.target.value))} /></label>
    <label>Style<select value={displayStyle} onChange={(event) => setDisplayStyle(event.target.value)}><option value="">Channel default</option>{bindingStyles.map((style) => <option key={style} value={style}>{style.replaceAll('_', ' ')}</option>)}</select></label>
    <label>Anchor<select value={anchor} onChange={(event) => setAnchor(event.target.value)}><option value="">Channel default</option>{bindingAnchors.map((value) => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}</select></label>
    <label>Scale<input type="number" min="0.5" max="2" step="0.1" value={scale} placeholder="Default" onChange={(event) => setScale(event.target.value)} /></label>
    <button className="secondary-button" type="submit">Save routing settings</button>
  </form>;
}
