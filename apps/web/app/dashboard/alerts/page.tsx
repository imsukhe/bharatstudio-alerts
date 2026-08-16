'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '../../components/AppShell';
import { authGateStates } from '../../components/AuthGateStates';
import {
  createBinding, createQueue, getBindings, getChannel, getChannelConfig, getCurrentUser, getQueues, sendTestAlert, updateBinding,
  updateChannelConfig, updateQueue, type ChannelConfig, type ChannelConfigValues, type ChannelDetails, type CurrentUser, type Queue, type QueueBinding,
} from '../../lib/api';
import { ChannelConfigEditor } from '../ChannelConfigEditor';

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

function mergeConfig(values: ChannelConfigValues): ChannelConfigValues {
  return {
    ...defaultConfig,
    ...values,
    display: { ...defaultConfig.display, ...values.display },
    queue: { ...defaultConfig.queue, ...values.queue },
    tts: { ...defaultConfig.tts, ...values.tts },
  };
}

export default function AlertsPage() {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [channel, setChannel] = useState<ChannelDetails | null>(null);
  const [queues, setQueues] = useState<Queue[]>([]);
  const [bindings, setBindings] = useState<QueueBinding[]>([]);
  const [config, setConfig] = useState<ChannelConfig | null>(null);
  const [configDraft, setConfigDraft] = useState<ChannelConfigValues>(defaultConfig);
  const [savingConfig, setSavingConfig] = useState(false);
  const [queueName, setQueueName] = useState('Main alerts');
  const [testMessage, setTestMessage] = useState('Welcome to the stream!');
  // Every mutation on this page used to funnel success and failure through
  // the same `message` string and the same gold inline-message/role="status"
  // styling — no color distinction for a sighted user, and the same
  // "polite" (non-interrupting) announcement for a screen reader regardless
  // of whether the action actually failed. `notify` below is the one place
  // that sets both message and its kind together, so no call site can
  // regress back to that.
  const [message, setMessage] = useState<string | null>(null);
  const [messageKind, setMessageKind] = useState<'success' | 'error'>('success');
  const [error, setError] = useState<string | null>(null);

  function notify(text: string, kind: 'success' | 'error') {
    setMessage(text);
    setMessageKind(kind);
  }

  useEffect(() => {
    getCurrentUser().then(async (nextUser) => {
      setUser(nextUser);
      const first = nextUser.channels[0];
      if (!first) { window.location.assign('/onboarding'); return; }
      const [nextChannel, nextQueues, nextConfig, nextBindings] = await Promise.all([
        getChannel(first.channelId), getQueues(first.channelId), getChannelConfig(first.channelId),
        bindingsUiEnabled ? getBindings(first.channelId) : Promise.resolve({ schemaVersion: 'v1' as const, bindings: [] }),
      ]);
      setChannel(nextChannel); setQueues(nextQueues.queues); setConfig(nextConfig); setConfigDraft(mergeConfig(nextConfig.values)); setBindings(nextBindings.bindings);
    }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Account data is unavailable'));
  }, []);

  const canOperateQueues = channel ? ['owner', 'admin', 'operator'].includes(channel.role ?? '') : false;

  async function submitConfig(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!channel || !config) return;
    setSavingConfig(true); setMessage(null);
    try {
      const next = await updateChannelConfig(channel.channelId, config.version, configDraft);
      setConfig(next); setConfigDraft(mergeConfig(next.values)); notify('Alert configuration saved.', 'success');
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'Configuration could not be saved. Reload and try again.', 'error');
    } finally { setSavingConfig(false); }
  }

  async function submitQueue(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!channel) return;
    try { const next = await createQueue(channel.channelId, queueName); setQueues([...queues, next]); setQueueName(''); notify('Queue created.', 'success'); }
    catch (cause) { notify(cause instanceof Error ? cause.message : 'Queue could not be created', 'error'); }
  }

  async function submitTestAlert(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!channel) return;
    try { await sendTestAlert(channel.channelId, user?.displayName ?? 'Viewer', testMessage); notify('Test alert accepted and added to the durable alert path.', 'success'); }
    catch (cause) { notify(cause instanceof Error ? cause.message : 'Test alert could not be accepted', 'error'); }
  }

  async function toggleQueue(queue: Queue) {
    if (!channel) return;
    try {
      const next = await updateQueue(channel.channelId, queue.queueId, { paused: !queue.paused });
      setQueues(queues.map((candidate) => candidate.queueId === next.queueId ? next : candidate));
      notify(`${next.name} is ${next.paused ? 'paused' : 'ready'}.`, 'success');
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'Queue could not be updated', 'error');
    }
  }

  async function toggleBinding(binding: QueueBinding) {
    if (!channel) return;
    try {
      const next = await updateBinding(channel.channelId, binding.bindingId, { allowDuplicates: !binding.allowDuplicates });
      setBindings(bindings.map((candidate) => candidate.bindingId === next.bindingId ? next : candidate));
      notify(`Routing for ${next.sourceId === '__channel_default__' ? 'new payments' : next.sourceId} updated.`, 'success');
    } catch (cause) { notify(cause instanceof Error ? cause.message : 'Binding could not be updated', 'error'); }
  }

  async function closeBinding(binding: QueueBinding) {
    if (!channel || binding.sourceId === '__channel_default__') return;
    try {
      const next = await updateBinding(channel.channelId, binding.bindingId, { active: false });
      setBindings(bindings.map((candidate) => candidate.bindingId === next.bindingId ? next : candidate));
      notify('Routing binding closed. Existing accepted deliveries are unchanged.', 'success');
    } catch (cause) { notify(cause instanceof Error ? cause.message : 'Binding could not be closed', 'error'); }
  }

  async function reopenBinding(binding: QueueBinding) {
    if (!channel) return;
    try {
      const next = await updateBinding(channel.channelId, binding.bindingId, { active: true });
      setBindings(bindings.map((candidate) => candidate.bindingId === next.bindingId ? next : candidate));
      notify('Routing binding reopened for future events.', 'success');
    } catch (cause) { notify(cause instanceof Error ? cause.message : 'Binding could not be reopened', 'error'); }
  }

  async function addBinding(input: { queueId: string; sourceType: QueueBinding['sourceType']; sourceId: string; allowDuplicates: boolean; priority: number }) {
    if (!channel) return;
    try { const next = await createBinding(channel.channelId, input); setBindings([next, ...bindings]); notify('Routing binding created for future events.', 'success'); }
    catch (cause) { notify(cause instanceof Error ? cause.message : 'Binding could not be created', 'error'); }
  }

  async function saveBinding(binding: QueueBinding, input: { priority: number; overrideValues: Record<string, unknown> | null }) {
    if (!channel) return;
    try { const next = await updateBinding(channel.channelId, binding.bindingId, input); setBindings(bindings.map((candidate) => candidate.bindingId === next.bindingId ? next : candidate)); notify('Source routing settings saved for future events.', 'success'); }
    catch (cause) { notify(cause instanceof Error ? cause.message : 'Routing settings could not be saved', 'error'); }
  }

  if (error) return authGateStates({ title: 'Alerts', error, ready: true });
  if (!channel || !config) return authGateStates({ title: 'Alerts', error: null, ready: false });

  return (
    <AppShell title="Alerts">
      {message && (messageKind === 'error'
        ? <p className="inline-message error-text" role="alert">{message}</p>
        : <p className="inline-message" role="status">{message}</p>)}
      <ChannelConfigEditor version={config.version} draft={configDraft} saving={savingConfig} onChange={setConfigDraft} onSubmit={submitConfig} />
      <section className="content-grid dashboard-controls">
        <article className="panel">
          <p className="muted-label">Queues</p>
          <h2>Keep every alert accounted for.</h2>
          <div className="queue-list">
            {queues.length === 0 ? <p>No queues yet.</p> : queues.map((queue) => (
              <div className="queue-row" key={queue.queueId}>
                <div><span>{queue.name}</span><small>{queue.paused ? 'Paused' : queue.active ? 'Ready' : 'Closed'}</small></div>
                {canOperateQueues && <button className="secondary-button" type="button" onClick={() => toggleQueue(queue)}>{queue.paused ? 'Resume' : 'Pause'}</button>}
              </div>
            ))}
          </div>
          {canOperateQueues && <form className="inline-form" onSubmit={submitQueue}><input required maxLength={80} value={queueName} onChange={(event) => setQueueName(event.target.value)} placeholder="New queue name" /><button className="secondary-button" type="submit">Add queue</button></form>}
        </article>
        <article className="panel">
          <p className="muted-label">Test alert</p>
          <h2>Preview the delivery path</h2>
          {canOperateQueues ? (
            <form className="dashboard-form" onSubmit={submitTestAlert}>
              <label>Message<textarea required maxLength={500} rows={3} value={testMessage} onChange={(event) => setTestMessage(event.target.value)} /></label>
              <button className="primary-button" type="submit">Send test alert</button>
            </form>
          ) : <p className="helper-text">Your channel role can view the queue state but cannot send test alerts.</p>}
        </article>
      </section>
      {bindingsUiEnabled && canOperateQueues && (
        <BindingControls bindings={bindings} queues={queues} onCreate={addBinding} onSave={saveBinding} onToggle={toggleBinding} onClose={closeBinding} onReopen={reopenBinding} />
      )}
    </AppShell>
  );
}

const bindingStyles = ['small_pill', 'compact_card', 'standard_card', 'large_card', 'banner', 'celebration'] as const;
const bindingAnchors = ['top_left', 'top_center', 'top_right', 'center_left', 'center', 'center_right', 'bottom_left', 'bottom_center', 'bottom_right'] as const;

function BindingControls({ bindings, queues, onCreate, onSave, onToggle, onClose, onReopen }: {
  bindings: QueueBinding[]; queues: Queue[];
  onCreate: (input: { queueId: string; sourceType: QueueBinding['sourceType']; sourceId: string; allowDuplicates: boolean; priority: number }) => void;
  onSave: (binding: QueueBinding, input: { priority: number; overrideValues: Record<string, unknown> | null }) => void;
  onToggle: (binding: QueueBinding) => void; onClose: (binding: QueueBinding) => void; onReopen: (binding: QueueBinding) => void;
}) {
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

  return (
    <section className="panel binding-panel" aria-labelledby="binding-controls-title">
      <div className="panel-heading"><div><p className="muted-label">Source routing</p><h2 id="binding-controls-title">Choose where each source appears</h2></div><span className="helper-text">Advanced</span></div>
      <p className="helper-text">The channel default route keeps new payments deliverable before a provider payment ID exists. Enabling duplicates on more than one active binding intentionally sends future matching events to each selected queue. Accepted deliveries already in progress keep their frozen route.</p>
      {bindings.length === 0 ? <p>No routing bindings are available.</p> : (
        <div className="binding-list">
          {bindings.map((binding) => (
            <div className={`binding-row${binding.active ? '' : ' is-closed'}`} key={binding.bindingId}>
              <div><strong>{binding.sourceId === '__channel_default__' ? 'New payments (default)' : binding.sourceId}</strong><small>{binding.sourceType} · {queueNames.get(binding.queueId) ?? 'Unknown queue'} · priority {binding.priority} · {binding.active ? 'Active' : 'Closed'}</small></div>
              <div className="control-actions">
                {binding.active && <button className="secondary-button" type="button" onClick={() => onToggle(binding)}>{binding.allowDuplicates ? 'Disable duplicate route' : 'Allow duplicate route'}</button>}
                {binding.active && binding.sourceId !== '__channel_default__' && <button className="secondary-button" type="button" onClick={() => onClose(binding)}>Close</button>}
                {!binding.active && <button className="secondary-button" type="button" onClick={() => onReopen(binding)}>Reopen</button>}
              </div>
              {binding.active && <BindingEditForm binding={binding} onSave={onSave} />}
            </div>
          ))}
        </div>
      )}
      <form className="binding-create-form" onSubmit={submit}>
        <p className="muted-label">Add a source binding</p>
        <div className="config-grid">
          <label>Queue<select required value={queueId} onChange={(event) => setQueueId(event.target.value)}>{activeQueues.map((queue) => <option key={queue.queueId} value={queue.queueId}>{queue.name}</option>)}</select></label>
          <label>Source type<select value={sourceType} onChange={(event) => setSourceType(event.target.value as QueueBinding['sourceType'])}><option value="payment">Payment</option><option value="manual">Manual</option><option value="companion">Companion</option></select></label>
          <label>Source ID<input required maxLength={128} value={sourceId} onChange={(event) => setSourceId(event.target.value)} placeholder="Payment provider ID, or a manual/Companion identifier" /></label>
          <label>Priority<input type="number" min="0" max="100000" value={priority} onChange={(event) => setPriority(Number(event.target.value))} /></label>
        </div>
        <label className="checkbox-label"><input type="checkbox" checked={allowDuplicates} onChange={(event) => setAllowDuplicates(event.target.checked)} /> Allow this source to route to another opted-in queue</label>
        <button className="secondary-button" type="submit" disabled={!queueId || !sourceId.trim()}>Add binding</button>
      </form>
    </section>
  );
}

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

  return (
    <form className="binding-edit-form" onSubmit={submit}>
      <label>Priority<input type="number" min="0" max="100000" value={priority} onChange={(event) => setPriority(Number(event.target.value))} /></label>
      <label>Style<select value={displayStyle} onChange={(event) => setDisplayStyle(event.target.value)}><option value="">Channel default</option>{bindingStyles.map((style) => <option key={style} value={style}>{style.replaceAll('_', ' ')}</option>)}</select></label>
      <label>Anchor<select value={anchor} onChange={(event) => setAnchor(event.target.value)}><option value="">Channel default</option>{bindingAnchors.map((value) => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}</select></label>
      <label>Scale<input type="number" min="0.5" max="2" step="0.1" value={scale} placeholder="Default" onChange={(event) => setScale(event.target.value)} /></label>
      <button className="secondary-button" type="submit">Save routing settings</button>
    </form>
  );
}
