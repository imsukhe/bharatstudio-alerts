'use client';

import { useState } from 'react';
import { Card } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';
import { StatusMessage } from '../../components/StatusMessage';
import { useStatusMessage } from '../../hooks/useStatusMessage';
import { useViewerBootstrap } from '../../hooks/useViewerBootstrap';
import { getViewerSessions, revokeViewerSession, type ViewerSessionSummary } from '../lib/viewer-api';
import { ViewerShell } from '../ViewerShell';

function formatDate(value: string): string {
  return new Date(value).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

export default function ViewerSessionsPage() {
  const [sessions, setSessions] = useState<ViewerSessionSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { message, messageKind, notify } = useStatusMessage();

  useViewerBootstrap(getViewerSessions, setSessions, setLoadError, 'Your sessions are unavailable');

  async function revoke(session: ViewerSessionSummary) {
    try {
      await revokeViewerSession(session.sessionId);
      setSessions((current) => (current ?? []).filter((item) => item.sessionId !== session.sessionId));
      notify('Session revoked', 'success');
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'Could not revoke that session', 'error');
    }
  }

  return (
    <ViewerShell title="Signed-in devices.">
      {loadError && <p className="error-text" role="alert">{loadError}</p>}
      {!loadError && sessions === null && <p className="helper-text" role="status">Loading…</p>}
      {!loadError && sessions !== null && (
        <Card eyebrow="Security" title="Active sessions">
          {sessions.length === 0 ? (
            <EmptyState>No active sessions.</EmptyState>
          ) : (
            <div className="session-list">
              {sessions.map((session) => (
                <div className="session-row" key={session.sessionId}>
                  <div>
                    <strong>{session.deviceLabel ?? 'Unnamed device'}{session.current ? ' · current' : ''}</strong>
                    <small>Last seen {formatDate(session.lastSeenAt)}</small>
                  </div>
                  {!session.current && <button className="secondary-button" type="button" onClick={() => void revoke(session)}>Revoke</button>}
                </div>
              ))}
            </div>
          )}
          <StatusMessage message={message} kind={messageKind} />
        </Card>
      )}
    </ViewerShell>
  );
}
