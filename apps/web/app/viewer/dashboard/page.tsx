'use client';

/*
 * Private lifetime dashboard: the viewer's OWN support history across
 * every creator they've supported (GET /v1/viewer/dashboard —
 * app_private.get_viewer_dashboard, migration 0085). This is deliberately
 * the only place that cross-creator sum is ever assembled or shown — a
 * creator's own pages never call this route and never see it.
 */
import { useState } from 'react';
import { Card } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';
import { useViewerBootstrap } from '../../hooks/useViewerBootstrap';
import { getViewerDashboard, type ViewerDashboardRow } from '../lib/viewer-api';
import { ViewerShell } from '../ViewerShell';

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString('en-IN', { dateStyle: 'medium' });
}

function formatRupees(paise: string): string {
  return `₹${(Number(paise) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

export default function ViewerDashboardPage() {
  const [rows, setRows] = useState<ViewerDashboardRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useViewerBootstrap(getViewerDashboard, setRows, setError, 'Your support history is unavailable');

  return (
    <ViewerShell title="Your support history.">
      {error && <p className="error-text" role="alert">{error}</p>}
      {!error && rows === null && <p className="helper-text" role="status">Loading…</p>}
      {!error && rows !== null && (
        <Card eyebrow="Lifetime, across every creator" title="Channels you've supported">
          {rows.length === 0 ? (
            <EmptyState>You haven&rsquo;t supported any channel yet.</EmptyState>
          ) : (
            <div className="status-list">
              {rows.map((row) => (
                <div key={row.channelId}>
                  <div>
                    <strong>{row.channelDisplayName}</strong>
                    <small>@{row.channelHandle} · first supported {formatDate(row.firstSupportedAt)} · last {formatDate(row.lastSupportedAt)}</small>
                  </div>
                  <div>
                    {formatRupees(row.lifetimeAmountPaise)} · {row.tipCount} tips
                    {Number(row.challengeCount) > 0 ? ` · ${row.challengeCount} challenges` : ''}
                    {row.memberState !== 'none' ? ` · member (${row.memberState})` : ''}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}
    </ViewerShell>
  );
}
