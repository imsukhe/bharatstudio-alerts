'use client';

/*
 * L16c contribution source selection. Lets a creator choose, per goal /
 * challenge / interaction definition, whether BharatStudio tips and/or
 * YouTube Super Chats count toward its target. Reuses the sibling
 * dashboard modules' own list-target functions unmodified
 * (listGoals/listChallenges/listInteractionDefinitions) rather than
 * re-declaring goal/challenge/interaction shapes here.
 *
 * DELIBERATELY include/exclude only. There is no percentage, weight, or
 * multiplier control anywhere below — see sources-api.ts's header and
 * apps/api/src/domain/contribution-source-types.ts for why a platform-cut
 * multiplier is refused: BharatStudio cannot compute a correct net rate for
 * a Super Chat (it never touches our rails), so offering one would present
 * our arithmetic on someone else's money as fact. A Super Chat is shown
 * GROSS wherever it is shown; the panel says so plainly instead of hiding
 * it behind a number.
 */
import { useEffect, useState } from 'react';
import { StatusMessage } from '../../components/StatusMessage';
import { useStatusMessage } from '../../hooks/useStatusMessage';
import { listGoals, type SupportGoal } from '../goals/goals-api';
import { listChallenges, type Challenge } from '../challenges/challenges-api';
import { listInteractionDefinitions, type InteractionDefinition } from '../interactions/interactions-api';
import { listSourceInclusions, setSourceInclusion, type ContributionSourceInclusion, type ContributionSourceType, type ContributionTargetKind } from './sources-api';

const SOURCE_LABELS: Record<ContributionSourceType, string> = {
  payment: 'BharatStudio tips',
  youtube_superchat: 'YouTube Super Chats',
};

// Fixed, known set — never derived from a server response, so an unknown
// future source type can't silently grow this list with no explanation.
const ALL_SOURCE_TYPES: readonly ContributionSourceType[] = ['payment', 'youtube_superchat'];

type Target = { kind: ContributionTargetKind; targetId: string; label: string };

function targetKey(target: Target): string {
  return `${target.kind}:${target.targetId}`;
}

// Missing row = included (migration 0117's default: aggregate everything
// until a creator explicitly excludes a source).
function inclusionFor(sources: ContributionSourceInclusion[], sourceType: ContributionSourceType): boolean {
  const row = sources.find((entry) => entry.sourceType === sourceType);
  return row ? row.included : true;
}

function SourceToggleRow({ channelId, target }: { channelId: string; target: Target }) {
  const [open, setOpen] = useState(false);
  const [sources, setSources] = useState<ContributionSourceInclusion[] | null>(null);
  const [saving, setSaving] = useState<ContributionSourceType | null>(null);
  const { message, messageKind, notify } = useStatusMessage();

  async function loadSources() {
    try {
      const result = await listSourceInclusions(channelId, target.kind, target.targetId);
      setSources(result.sources);
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'Contribution sources are temporarily unavailable', 'error');
    }
  }

  async function toggle(sourceType: ContributionSourceType, currentlyIncluded: boolean) {
    setSaving(sourceType);
    try {
      const result = await setSourceInclusion(channelId, target.kind, target.targetId, sourceType, !currentlyIncluded);
      setSources(result.sources);
      notify(`${SOURCE_LABELS[sourceType]} ${!currentlyIncluded ? 'now counts' : 'no longer counts'} toward "${target.label}".`, 'success');
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'The contribution source could not be updated', 'error');
    } finally {
      setSaving(null);
    }
  }

  return (
    <li className="sources-target-row" data-target-key={targetKey(target)}>
      <div className="sources-target-heading">
        <strong>{target.label}</strong>
        <button
          type="button"
          className="secondary-button"
          onClick={() => { const next = !open; setOpen(next); if (next && sources === null) void loadSources(); }}
        >
          {open ? 'Hide sources' : 'Manage sources'}
        </button>
      </div>
      {open && (
        <div className="sources-target-body">
          <StatusMessage message={message} kind={messageKind} />
          {sources === null && <p className="helper-text" role="status">Loading…</p>}
          {sources !== null && (
            <ul className="sources-toggle-list">
              {ALL_SOURCE_TYPES.map((sourceType) => {
                const included = inclusionFor(sources, sourceType);
                return (
                  <li key={sourceType}>
                    <label>
                      <input
                        type="checkbox"
                        checked={included}
                        disabled={saving === sourceType}
                        onChange={() => void toggle(sourceType, included)}
                      />
                      {SOURCE_LABELS[sourceType]}
                    </label>
                    {sourceType === 'youtube_superchat' && (
                      <p className="helper-text">Shown as the full amount YouTube reports — BharatStudio never sees or nets out YouTube's platform cut, so no percentage is applied.</p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

export function SourcesPanel({ channelId, canManage }: { channelId: string; canManage: boolean }) {
  const [goals, setGoals] = useState<SupportGoal[] | null>(null);
  const [challenges, setChallenges] = useState<Challenge[] | null>(null);
  const [interactions, setInteractions] = useState<InteractionDefinition[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listGoals(channelId), listChallenges(channelId), listInteractionDefinitions(channelId)])
      .then(([goalsResult, challengesResult, interactionsResult]) => {
        if (cancelled) return;
        setGoals(goalsResult.items);
        setChallenges(challengesResult.items);
        setInteractions(interactionsResult.items);
      })
      .catch((cause) => { if (!cancelled) setLoadError(cause instanceof Error ? cause.message : 'Targets are temporarily unavailable'); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  if (!canManage) return <p className="helper-text">Only the channel owner or an admin can choose which contribution sources count toward a target.</p>;
  if (loadError) return <p className="error-text" role="alert">{loadError}</p>;
  if (goals === null || challenges === null || interactions === null) return <p className="helper-text" role="status">Loading…</p>;

  const goalTargets: Target[] = goals.filter((goal) => !goal.ended).map((goal) => ({ kind: 'goal', targetId: goal.goalId, label: goal.title }));
  const challengeTargets: Target[] = challenges.filter((challenge) => challenge.state !== 'cancelled').map((challenge) => ({ kind: 'challenge', targetId: challenge.challengeId, label: challenge.title }));
  const interactionTargets: Target[] = interactions.filter((definition) => !definition.closed).map((definition) => ({ kind: 'interaction', targetId: definition.definitionId, label: definition.label }));

  return (
    <div className="sources-panel">
      <p className="helper-text">A target with no explicit choice counts every source. Turning a source off here only stops it from counting toward this target — it never edits, refunds, or hides the underlying tip or Super Chat itself.</p>

      <section aria-labelledby="sources-goals-heading">
        <h3 id="sources-goals-heading">Support goals</h3>
        {goalTargets.length === 0 && <p className="helper-text">No active support goals.</p>}
        {goalTargets.length > 0 && <ul className="sources-target-list">{goalTargets.map((target) => <SourceToggleRow key={targetKey(target)} channelId={channelId} target={target} />)}</ul>}
      </section>

      <section aria-labelledby="sources-challenges-heading">
        <h3 id="sources-challenges-heading">Challenges</h3>
        {challengeTargets.length === 0 && <p className="helper-text">No active challenges.</p>}
        {challengeTargets.length > 0 && <ul className="sources-target-list">{challengeTargets.map((target) => <SourceToggleRow key={targetKey(target)} channelId={channelId} target={target} />)}</ul>}
      </section>

      <section aria-labelledby="sources-interactions-heading">
        <h3 id="sources-interactions-heading">Interactions</h3>
        {interactionTargets.length === 0 && <p className="helper-text">No active interaction definitions.</p>}
        {interactionTargets.length > 0 && <ul className="sources-target-list">{interactionTargets.map((target) => <SourceToggleRow key={targetKey(target)} channelId={channelId} target={target} />)}</ul>}
      </section>
    </div>
  );
}
