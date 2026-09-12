'use client';

/*
 * Creator management UI for L16 support goals. Reuses the shared
 * useStatusMessage/StatusMessage pair and the ui/* primitives — no new
 * notification or form-field pattern is introduced here.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { StatusMessage } from '../../components/StatusMessage';
import { useStatusMessage } from '../../hooks/useStatusMessage';
import { Button } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import { createGoal, endGoal, listGoals, type GoalWindow, type SupportGoal } from './goals-api';

const WINDOW_LABELS: Record<GoalWindow, string> = {
  stream: 'This stream (until you end it)',
  daily: 'Daily (resets at midnight UTC)',
  monthly: 'Monthly (resets on the 1st, UTC)',
  open: 'Open-ended (no reset)',
};

function formatRupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN')}`;
}

function progressPercent(goal: SupportGoal): number {
  if (goal.targetAmountPaise <= 0) return 0;
  return Math.min(100, Math.round((goal.progressPaise / goal.targetAmountPaise) * 100));
}

export function GoalsPanel({ channelId, canManage }: { channelId: string; canManage: boolean }) {
  const [goals, setGoals] = useState<SupportGoal[] | null>(null);
  const [title, setTitle] = useState('');
  const [targetRupees, setTargetRupees] = useState('');
  const [window, setWindowValue] = useState<GoalWindow>('stream');
  const [isPublic, setIsPublic] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const { message, messageKind, notify } = useStatusMessage();

  useEffect(() => {
    let cancelled = false;
    listGoals(channelId)
      .then((response) => { if (!cancelled) setGoals(response.items); })
      .catch((cause) => { if (!cancelled) notify(cause instanceof Error ? cause.message : 'Support goals are temporarily unavailable', 'error'); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  async function refresh() {
    try {
      const response = await listGoals(channelId);
      setGoals(response.items);
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'Support goals are temporarily unavailable', 'error');
    }
  }

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    const rupees = Number(targetRupees);
    if (!title.trim() || !Number.isFinite(rupees) || rupees < 10) {
      notify('Enter a title and a target of at least ₹10.', 'error');
      return;
    }
    setSubmitting(true);
    try {
      await createGoal(channelId, { title: title.trim(), targetAmountPaise: Math.round(rupees * 100), window, isPublic });
      setTitle('');
      setTargetRupees('');
      setWindowValue('stream');
      setIsPublic(true);
      notify('Support goal created.', 'success');
      await refresh();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'The support goal could not be created', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  async function onEnd(goalId: string) {
    try {
      await endGoal(channelId, goalId);
      notify('Support goal ended.', 'success');
      await refresh();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'The support goal could not be ended', 'error');
    }
  }

  return (
    <div className="goals-panel">
      <StatusMessage message={message} kind={messageKind} />

      {canManage && (
        <form onSubmit={(event) => void onCreate(event)} className="goals-create-form">
          <Field label="Goal title">
            <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} placeholder="New PC fund" />
          </Field>
          <Field label="Target (₹)">
            <input value={targetRupees} onChange={(event) => setTargetRupees(event.target.value)} inputMode="decimal" placeholder="10000" />
          </Field>
          <Field label="Window">
            <select value={window} onChange={(event) => setWindowValue(event.target.value as GoalWindow)}>
              {(Object.keys(WINDOW_LABELS) as GoalWindow[]).map((value) => (
                <option key={value} value={value}>{WINDOW_LABELS[value]}</option>
              ))}
            </select>
          </Field>
          <label className="goals-public-toggle">
            <input type="checkbox" checked={isPublic} onChange={(event) => setIsPublic(event.target.checked)} />
            Show on the overlay widget
          </label>
          <Button type="submit" variant="primary" disabled={submitting}>{submitting ? 'Creating…' : 'Create goal'}</Button>
        </form>
      )}
      {!canManage && <p className="helper-text">Only the channel owner or an admin can create or end support goals.</p>}

      {goals === null && <p className="helper-text" role="status">Loading…</p>}
      {goals !== null && goals.length === 0 && <p className="helper-text">No support goals yet.</p>}
      {goals !== null && goals.length > 0 && (
        <ul className="goals-list">
          {goals.map((goal) => (
            <li key={goal.goalId} className="goals-list-item">
              <div className="goals-list-heading">
                <strong>{goal.title}</strong>
                <span>{goal.ended ? 'Ended' : goal.reached ? 'Reached' : 'Active'}</span>
              </div>
              <div className="goals-progress-track" role="progressbar" aria-valuenow={progressPercent(goal)} aria-valuemin={0} aria-valuemax={100}>
                <div className="goals-progress-fill" style={{ width: `${progressPercent(goal)}%` }} />
              </div>
              <p className="helper-text">{formatRupees(goal.progressPaise)} of {formatRupees(goal.targetAmountPaise)} — {WINDOW_LABELS[goal.window]} — {goal.isPublic ? 'Public' : 'Private'}</p>
              {canManage && !goal.ended && (
                <Button type="button" onClick={() => void onEnd(goal.goalId)}>End goal</Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
