'use client';

/*
 * Creator management UI for L16 interaction definitions, widget configs
 * and the leaderboard. Reuses the shared useStatusMessage/StatusMessage
 * pair and the ui/* primitives, same as ../goals/GoalsPanel.tsx — no new
 * notification or form-field pattern is introduced here.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { StatusMessage } from '../../components/StatusMessage';
import { useStatusMessage } from '../../hooks/useStatusMessage';
import { Button } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import {
  closeInteractionDefinition, createInteractionDefinition, createWidgetConfig, deleteWidgetConfig,
  getLeaderboard, listInteractionDefinitions, listWidgetConfigs,
  type InteractionDefinition, type InteractionType, type Leaderboard, type WidgetConfig, type WidgetType,
} from './interactions-api';

const INTERACTION_TYPE_LABELS: Record<InteractionType, string> = {
  tip: 'Tip', tts_tip: 'TTS tip', sticker: 'Sticker/reaction', mega_alert: 'Mega alert',
  priority_question: 'Priority question', support_vote: 'Support vote', community_goal: 'Community goal', hype_mode: 'Hype mode',
};

const WIDGET_TYPE_LABELS: Record<WidgetType, string> = {
  main_alert: 'Main alert', support_goal: 'Support goal', recent_tips: 'Recent tips', top_supporters: 'Top supporters',
  supporter_ticker: 'Supporter ticker', public_leaderboard: 'Public leaderboard', mega_tip_banner: 'Mega-tip banner',
};

function formatRupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN')}`;
}

export function InteractionsPanel({ channelId, canManage, queueId }: { channelId: string; canManage: boolean; queueId: string }) {
  const [definitions, setDefinitions] = useState<InteractionDefinition[] | null>(null);
  const [widgets, setWidgets] = useState<WidgetConfig[] | null>(null);
  const [board, setBoard] = useState<Leaderboard | null>(null);
  const [interactionType, setInteractionType] = useState<InteractionType>('tip');
  const [label, setLabel] = useState('');
  const [amountRupees, setAmountRupees] = useState('');
  const [widgetType, setWidgetType] = useState<WidgetType>('recent_tips');
  const [submittingDefinition, setSubmittingDefinition] = useState(false);
  const [submittingWidget, setSubmittingWidget] = useState(false);
  const { message, messageKind, notify } = useStatusMessage();

  useEffect(() => {
    let cancelled = false;
    Promise.all([listInteractionDefinitions(channelId), listWidgetConfigs(channelId), getLeaderboard(channelId, 'all')])
      .then(([defs, wids, lb]) => { if (!cancelled) { setDefinitions(defs.items); setWidgets(wids.items); setBoard(lb); } })
      .catch((cause) => { if (!cancelled) notify(cause instanceof Error ? cause.message : 'Interactions are temporarily unavailable', 'error'); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  async function refreshDefinitions() {
    try { setDefinitions((await listInteractionDefinitions(channelId)).items); }
    catch (cause) { notify(cause instanceof Error ? cause.message : 'Interactions are temporarily unavailable', 'error'); }
  }

  async function refreshWidgets() {
    try { setWidgets((await listWidgetConfigs(channelId)).items); }
    catch (cause) { notify(cause instanceof Error ? cause.message : 'Widgets are temporarily unavailable', 'error'); }
  }

  const needsAmount = !['support_vote', 'community_goal', 'hype_mode'].includes(interactionType);

  async function onCreateDefinition(event: FormEvent) {
    event.preventDefault();
    if (!label.trim()) { notify('Enter a label.', 'error'); return; }
    let amountPaise: number | null = null;
    if (needsAmount) {
      const rupees = Number(amountRupees);
      if (!Number.isFinite(rupees) || rupees < 10) { notify('Enter an amount of at least ₹10.', 'error'); return; }
      amountPaise = Math.round(rupees * 100);
    }
    setSubmittingDefinition(true);
    try {
      await createInteractionDefinition(channelId, {
        interactionType, label: label.trim(), amountPaise, queueId,
        config: interactionType === 'hype_mode' ? { thresholdPaise: amountPaise ?? 500000, decaySeconds: 120 } : {},
      });
      setLabel(''); setAmountRupees('');
      notify('Interaction created.', 'success');
      await refreshDefinitions();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'The interaction could not be created', 'error');
    } finally {
      setSubmittingDefinition(false);
    }
  }

  async function onClose(definitionId: string) {
    try { await closeInteractionDefinition(channelId, definitionId); notify('Interaction closed.', 'success'); await refreshDefinitions(); }
    catch (cause) { notify(cause instanceof Error ? cause.message : 'The interaction could not be closed', 'error'); }
  }

  async function onCreateWidget(event: FormEvent) {
    event.preventDefault();
    setSubmittingWidget(true);
    try {
      await createWidgetConfig(channelId, { widgetType });
      notify('Widget created.', 'success');
      await refreshWidgets();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'The widget could not be created', 'error');
    } finally {
      setSubmittingWidget(false);
    }
  }

  async function onDeleteWidget(widgetConfigId: string) {
    try { await deleteWidgetConfig(channelId, widgetConfigId); notify('Widget removed.', 'success'); await refreshWidgets(); }
    catch (cause) { notify(cause instanceof Error ? cause.message : 'The widget could not be removed', 'error'); }
  }

  return (
    <div className="interactions-panel">
      <StatusMessage message={message} kind={messageKind} />

      <section aria-labelledby="interactions-catalogue-title">
        <h3 id="interactions-catalogue-title">Interaction catalogue</h3>
        {canManage && (
          <form onSubmit={(event) => void onCreateDefinition(event)} className="interactions-create-form">
            <Field label="Type">
              <select value={interactionType} onChange={(event) => setInteractionType(event.target.value as InteractionType)}>
                {(Object.keys(INTERACTION_TYPE_LABELS) as InteractionType[]).map((value) => (
                  <option key={value} value={value}>{INTERACTION_TYPE_LABELS[value]}</option>
                ))}
              </select>
            </Field>
            <Field label="Label">
              <input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={120} placeholder="Priority question" />
            </Field>
            {needsAmount && (
              <Field label="Amount (₹)">
                <input value={amountRupees} onChange={(event) => setAmountRupees(event.target.value)} inputMode="decimal" placeholder="100" />
              </Field>
            )}
            <Button type="submit" variant="primary" disabled={submittingDefinition}>{submittingDefinition ? 'Creating…' : 'Add interaction'}</Button>
          </form>
        )}
        {!canManage && <p className="helper-text">Only the channel owner or an admin can configure interactions.</p>}

        {definitions === null && <p className="helper-text" role="status">Loading…</p>}
        {definitions !== null && definitions.length === 0 && <p className="helper-text">No interactions configured yet.</p>}
        {definitions !== null && definitions.length > 0 && (
          <ul className="interactions-list">
            {definitions.map((def) => (
              <li key={def.definitionId} className="interactions-list-item">
                <strong>{def.label}</strong> — {INTERACTION_TYPE_LABELS[def.interactionType]}
                {def.amountPaise !== null && <span> — {formatRupees(def.amountPaise)}</span>}
                <span> — {def.closed ? 'Closed' : def.isEnabled ? 'Active' : 'Disabled'}</span>
                {canManage && !def.closed && (def.interactionType === 'support_vote' || def.interactionType === 'hype_mode') && (
                  <Button type="button" onClick={() => void onClose(def.definitionId)}>Close</Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="widgets-title">
        <h3 id="widgets-title">Overlay widgets</h3>
        {canManage && (
          <form onSubmit={(event) => void onCreateWidget(event)} className="widgets-create-form">
            <Field label="Widget type">
              <select value={widgetType} onChange={(event) => setWidgetType(event.target.value as WidgetType)}>
                {(Object.keys(WIDGET_TYPE_LABELS) as WidgetType[]).map((value) => (
                  <option key={value} value={value}>{WIDGET_TYPE_LABELS[value]}</option>
                ))}
              </select>
            </Field>
            <Button type="submit" variant="primary" disabled={submittingWidget}>{submittingWidget ? 'Adding…' : 'Add widget'}</Button>
          </form>
        )}
        {widgets === null && <p className="helper-text" role="status">Loading…</p>}
        {widgets !== null && widgets.length === 0 && <p className="helper-text">No widgets configured yet.</p>}
        {widgets !== null && widgets.length > 0 && (
          <ul className="widgets-list">
            {widgets.map((widget) => (
              <li key={widget.widgetConfigId} className="widgets-list-item">
                {WIDGET_TYPE_LABELS[widget.widgetType]} — {widget.privacyScope === 'public' ? 'Live on overlay' : 'Dashboard preview only'}
                {canManage && <Button type="button" onClick={() => void onDeleteWidget(widget.widgetConfigId)}>Remove</Button>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="leaderboard-title">
        <h3 id="leaderboard-title">Supporters</h3>
        <p className="helper-text">Your own channel&apos;s supporters only — never another creator&apos;s data, and never an exact lifetime amount.</p>
        {board === null && <p className="helper-text" role="status">Loading…</p>}
        {board !== null && board.rows.length === 0 && <p className="helper-text">No supporters yet.</p>}
        {board !== null && board.rows.length > 0 && (
          <ol className="leaderboard-list">
            {board.rows.map((row) => (
              <li key={row.viewerRef}>#{row.rank} — {row.tierLabel}</li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
