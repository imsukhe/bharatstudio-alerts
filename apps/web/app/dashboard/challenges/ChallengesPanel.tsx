'use client';

/*
 * Creator management UI for L17 paid challenges. Reuses the shared
 * useStatusMessage/StatusMessage pair and the ui/* primitives, exactly
 * like ../goals/GoalsPanel.tsx — no new notification or form-field
 * pattern is introduced here.
 *
 * HONEST FAILURE COPY: this system cannot initiate a refund (see
 * apps/api/src/domain/challenge-store.ts's CHALLENGE_FAILURE_COPY, which
 * this file renders verbatim rather than re-typing it — the API response
 * itself carries the string so the dashboard and the OBS widget can never
 * drift from each other or from the API's own copy). It is shown once,
 * prominently, above the create form and the list, so a creator sees it
 * before publishing a challenge a contributor might see.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { StatusMessage } from '../../components/StatusMessage';
import { useStatusMessage } from '../../hooks/useStatusMessage';
import { Button } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import { createChallenge, listChallenges, transitionChallenge, type Challenge, type ChallengeKind } from './challenges-api';

const KIND_LABELS: Record<ChallengeKind, string> = {
  stake: 'Stake (I will do X if we hit the target)',
  bounty: 'Bounty (viewers fund a specific ask)',
};

const STATE_LABELS: Record<Challenge['state'], string> = {
  draft: 'Draft — not visible to viewers yet',
  active: 'In progress',
  succeeded: 'Succeeded',
  failed: 'Did not happen',
  cancelled: 'Cancelled',
};

function formatRupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN')}`;
}

function progressPercent(challenge: Challenge): number {
  if (challenge.targetAmountPaise <= 0) return 0;
  return Math.min(100, Math.round((challenge.progressPaise / challenge.targetAmountPaise) * 100));
}

export function ChallengesPanel({ channelId, canManage }: { channelId: string; canManage: boolean }) {
  const [challenges, setChallenges] = useState<Challenge[] | null>(null);
  const [failureCopy, setFailureCopy] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [kind, setKind] = useState<ChallengeKind>('stake');
  const [targetRupees, setTargetRupees] = useState('');
  const [isPublic, setIsPublic] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const { message, messageKind, notify } = useStatusMessage();

  useEffect(() => {
    let cancelled = false;
    listChallenges(channelId)
      .then((response) => { if (!cancelled) { setChallenges(response.items); setFailureCopy(response.failureCopy); } })
      .catch((cause) => { if (!cancelled) notify(cause instanceof Error ? cause.message : 'Challenges are temporarily unavailable', 'error'); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  async function refresh() {
    try {
      const response = await listChallenges(channelId);
      setChallenges(response.items);
      setFailureCopy(response.failureCopy);
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'Challenges are temporarily unavailable', 'error');
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
      await createChallenge(channelId, {
        title: title.trim(),
        description: description.trim() || undefined,
        kind,
        targetAmountPaise: Math.round(rupees * 100),
        isPublic,
      });
      setTitle('');
      setDescription('');
      setKind('stake');
      setTargetRupees('');
      setIsPublic(true);
      notify('Challenge created as a draft. Start it when you\'re ready for viewers to see it.', 'success');
      await refresh();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'The challenge could not be created', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  async function onTransition(challengeId: string, toState: 'active' | 'succeeded' | 'failed' | 'cancelled') {
    try {
      await transitionChallenge(channelId, challengeId, toState);
      notify(`Challenge marked ${STATE_LABELS[toState].toLowerCase()}.`, 'success');
      await refresh();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'The challenge could not be updated', 'error');
    }
  }

  return (
    <div className="challenges-panel">
      <StatusMessage message={message} kind={messageKind} />

      {failureCopy && (
        <p className="helper-text challenges-failure-copy" role="note">{failureCopy}</p>
      )}

      {canManage && (
        <form onSubmit={(event) => void onCreate(event)} className="challenges-create-form">
          <Field label="Challenge title">
            <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} placeholder="Shave my head at ₹5,000" />
          </Field>
          <Field label="What happens (optional)">
            <input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} placeholder="If we hit the target, it happens live on stream." />
          </Field>
          <Field label="Kind">
            <select value={kind} onChange={(event) => setKind(event.target.value as ChallengeKind)}>
              {(Object.keys(KIND_LABELS) as ChallengeKind[]).map((value) => (
                <option key={value} value={value}>{KIND_LABELS[value]}</option>
              ))}
            </select>
          </Field>
          <Field label="Target (₹)">
            <input value={targetRupees} onChange={(event) => setTargetRupees(event.target.value)} inputMode="decimal" placeholder="5000" />
          </Field>
          <label className="challenges-public-toggle">
            <input type="checkbox" checked={isPublic} onChange={(event) => setIsPublic(event.target.checked)} />
            Show on the overlay widget once started
          </label>
          <Button type="submit" variant="primary" disabled={submitting}>{submitting ? 'Creating…' : 'Create challenge'}</Button>
        </form>
      )}
      {!canManage && <p className="helper-text">Only the channel owner or an admin can create or manage challenges.</p>}

      {challenges === null && <p className="helper-text" role="status">Loading…</p>}
      {challenges !== null && challenges.length === 0 && <p className="helper-text">No challenges yet.</p>}
      {challenges !== null && challenges.length > 0 && (
        <ul className="challenges-list">
          {challenges.map((challenge) => (
            <li key={challenge.challengeId} className="challenges-list-item">
              <div className="challenges-list-heading">
                <strong>{challenge.title}</strong>
                <span>{STATE_LABELS[challenge.state]}</span>
              </div>
              {challenge.description && <p className="helper-text">{challenge.description}</p>}
              <div className="challenges-progress-track" role="progressbar" aria-valuenow={progressPercent(challenge)} aria-valuemin={0} aria-valuemax={100}>
                <div className="challenges-progress-fill" style={{ width: `${progressPercent(challenge)}%` }} />
              </div>
              <p className="helper-text">
                {formatRupees(challenge.progressPaise)} of {formatRupees(challenge.targetAmountPaise)} — {KIND_LABELS[challenge.kind]} — {challenge.isPublic ? 'Public' : 'Private'}
              </p>
              {canManage && challenge.state === 'draft' && (
                <div className="challenges-actions">
                  <Button type="button" variant="primary" onClick={() => void onTransition(challenge.challengeId, 'active')}>Start</Button>
                  <Button type="button" onClick={() => void onTransition(challenge.challengeId, 'cancelled')}>Cancel</Button>
                </div>
              )}
              {canManage && challenge.state === 'active' && (
                <div className="challenges-actions">
                  <Button type="button" variant="primary" onClick={() => void onTransition(challenge.challengeId, 'succeeded')}>Mark succeeded</Button>
                  <Button type="button" onClick={() => void onTransition(challenge.challengeId, 'failed')}>Mark failed</Button>
                  <Button type="button" onClick={() => void onTransition(challenge.challengeId, 'cancelled')}>Cancel</Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
