'use client';

/*
 * Creator management UI for L23 AI assist. Every suggestion here is a
 * PROPOSAL — nothing renders as already applied. Accept/Reject are the
 * only two actions on a pending suggestion, and both are handled by the
 * server's human-confirmation endpoint (assist-api.ts's
 * decideAssistSuggestion) — there is no "apply directly" button anywhere
 * on this page, by design (see packages/db/migrations/0121's header).
 */
import { useEffect, useState } from 'react';
import { StatusMessage } from '../../components/StatusMessage';
import { useStatusMessage } from '../../hooks/useStatusMessage';
import { Button } from '../../components/ui/Button';
import {
  decideAssistSuggestion,
  generateAssistSuggestion,
  getAssistSuggestionAudit,
  listAssistSuggestions,
  type AssistSuggestion,
  type AssistSuggestionAudit,
  type AssistSurface,
} from './assist-api';

const SURFACE_LABELS: Record<AssistSurface, string> = {
  config: 'Configuration suggestion',
  challenge_copy: 'Challenge copy suggestion',
  translation: 'Translation suggestion',
  alert_style: 'Alert style proposal',
  moderation: 'Moderation suggestion',
};

// Per-surface acceptor roles, mirrored from app_private.decide_assist_suggestion
// (0121) purely so the UI can explain *why* a control is disabled rather
// than showing a dead button — the server enforces the real gate either way.
const ACCEPT_ROLES: Record<AssistSurface, string[]> = {
  config: ['owner', 'admin'],
  challenge_copy: ['owner', 'admin'],
  alert_style: ['owner', 'admin'],
  translation: ['owner', 'admin', 'operator'],
  moderation: ['owner', 'admin', 'moderator'],
};

function canDecide(surface: AssistSurface, role: string | undefined): boolean {
  return !!role && ACCEPT_ROLES[surface].includes(role);
}

export function AssistPanel({ channelId, role, tier, canRequest }: {
  channelId: string;
  role: string | undefined;
  tier: 'free' | 'pro' | 'creator' | 'studio';
  canRequest: boolean;
}) {
  const [suggestions, setSuggestions] = useState<AssistSuggestion[] | null>(null);
  const [surface, setSurface] = useState<AssistSurface>('config');
  const [requesting, setRequesting] = useState(false);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [audits, setAudits] = useState<Record<string, AssistSuggestionAudit>>({});
  const { message, messageKind, notify } = useStatusMessage();

  async function refresh() {
    try {
      const response = await listAssistSuggestions(channelId);
      setSuggestions(response.items);
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'AI assist is temporarily unavailable', 'error');
    }
  }

  useEffect(() => {
    let cancelled = false;
    listAssistSuggestions(channelId)
      .then((response) => { if (!cancelled) setSuggestions(response.items); })
      .catch((cause) => { if (!cancelled) notify(cause instanceof Error ? cause.message : 'AI assist is temporarily unavailable', 'error'); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  async function onRequestSuggestion() {
    setRequesting(true);
    try {
      await generateAssistSuggestion(channelId, { surface, tier });
      notify('Suggestion generated. It changes nothing until you accept it.', 'success');
      await refresh();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'The suggestion could not be generated', 'error');
    } finally {
      setRequesting(false);
    }
  }

  async function onDecide(suggestion: AssistSuggestion, decision: 'accepted' | 'rejected') {
    setDecidingId(suggestion.suggestionId);
    try {
      await decideAssistSuggestion(channelId, suggestion.suggestionId, { decision });
      notify(decision === 'accepted'
        ? 'Suggestion accepted. Apply it on its own screen (config / challenge / alert style / moderation) — accepting here does not change anything live.'
        : 'Suggestion rejected and recorded.', 'success');
      await refresh();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'The decision could not be recorded', 'error');
    } finally {
      setDecidingId(null);
    }
  }

  async function onViewAudit(suggestionId: string) {
    try {
      const audit = await getAssistSuggestionAudit(channelId, suggestionId);
      setAudits((prior) => ({ ...prior, [suggestionId]: audit }));
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'The audit trail could not be loaded', 'error');
    }
  }

  return (
    <div className="assist-panel">
      <StatusMessage message={message} kind={messageKind} />

      {canRequest && (
        <div className="assist-request-form">
          <label htmlFor="assist-surface">Surface</label>
          <select id="assist-surface" value={surface} onChange={(event) => setSurface(event.target.value as AssistSurface)}>
            {(Object.keys(SURFACE_LABELS) as AssistSurface[]).map((value) => (
              <option key={value} value={value}>{SURFACE_LABELS[value]}</option>
            ))}
          </select>
          <Button type="button" variant="primary" disabled={requesting} onClick={() => void onRequestSuggestion()}>
            {requesting ? 'Generating…' : 'Get a suggestion'}
          </Button>
        </div>
      )}
      {!canRequest && <p className="helper-text">AI assist is not available on the free tier.</p>}

      {suggestions === null && <p className="helper-text" role="status">Loading…</p>}
      {suggestions !== null && suggestions.length === 0 && <p className="helper-text">No suggestions yet.</p>}
      {suggestions !== null && suggestions.length > 0 && (
        <ul className="assist-list">
          {suggestions.map((suggestion) => {
            const audit = audits[suggestion.suggestionId];
            const decidable = canDecide(suggestion.surface, role);
            return (
              <li key={suggestion.suggestionId} className="assist-list-item">
                <div className="assist-list-heading">
                  <strong>{SURFACE_LABELS[suggestion.surface]}</strong>
                  <span>{suggestion.status === 'pending' ? 'Proposed — not applied' : suggestion.status === 'accepted' ? 'Accepted (apply separately)' : 'Rejected'}</span>
                </div>
                <p className="helper-text">Basis: {suggestion.basis}</p>
                <pre className="assist-payload">{JSON.stringify(suggestion.suggestedPayload)}</pre>
                {suggestion.status === 'pending' && (
                  decidable ? (
                    <div className="assist-actions">
                      <Button type="button" variant="primary" disabled={decidingId === suggestion.suggestionId} onClick={() => void onDecide(suggestion, 'accepted')}>Accept</Button>
                      <Button type="button" disabled={decidingId === suggestion.suggestionId} onClick={() => void onDecide(suggestion, 'rejected')}>Reject</Button>
                    </div>
                  ) : (
                    <p className="helper-text">Only {ACCEPT_ROLES[suggestion.surface].join('/')} can decide this suggestion.</p>
                  )
                )}
                {suggestion.status !== 'pending' && !audit && (
                  <Button type="button" onClick={() => void onViewAudit(suggestion.suggestionId)}>View audit trail</Button>
                )}
                {audit && audit.confirmation && (
                  <p className="helper-text">
                    {audit.confirmation.decision === 'accepted' ? 'Accepted' : 'Rejected'} by {audit.confirmation.decidedByRole} on {new Date(audit.confirmation.decidedAt).toLocaleString()}.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
