'use client';

/*
 * Payment ledger: owner/admin can view raw payment/refund records —
 * 00_LAUNCH_SCOPE_AUTHORITY.md already grants this, but nothing in the
 * application had ever exposed a UI for it. Reads GET /v1/channels/:id/
 * payments (paginated, database-enforced owner/admin-only). CSV export is a
 * plain data download of already-authorized fields — deliberately not a
 * tax/CA-compliance report; see the migration this reads from
 * (0071_v1_l03_payment_ledger_read.sql) for why that distinction is drawn
 * on purpose.
 */
import { useEffect, useState } from 'react';
import { getCurrentUser, getPayments, type CurrentUser, type PaymentLedgerEntry } from '../lib/api';
import { AppShell } from '../components/AppShell';

const MAX_EXPORT_PAGES = 20;

function formatMoney(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

function statusLabel(value: string): string {
  return value.replaceAll('_', ' ');
}

function toCsv(entries: PaymentLedgerEntry[]): string {
  const header = ['Date', 'Payment ID', 'Amount (INR)', 'Status', 'Refunded (INR)', 'Latest refund status'];
  const rows = entries.map((entry) => [
    entry.createdAt,
    entry.providerPaymentId,
    (entry.grossAmountPaise / 100).toFixed(2),
    entry.status,
    (entry.refundTotalPaise / 100).toFixed(2),
    entry.latestRefundStatus ?? '',
  ]);
  const escape = (value: string) => (/[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
  return [header, ...rows].map((row) => row.map(escape).join(',')).join('\n');
}

export default function PaymentsPage() {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [canView, setCanView] = useState(false);
  const [entries, setEntries] = useState<PaymentLedgerEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getCurrentUser().then(async (nextUser) => {
      setUser(nextUser);
      const first = nextUser.channels[0];
      if (!first) { setLoading(false); return; }
      setChannelId(first.channelId);
      const viewable = first.role === 'owner' || first.role === 'admin';
      setCanView(viewable);
      if (!viewable) { setLoading(false); return; }
      const page = await getPayments(first.channelId);
      setEntries(page.items);
      setNextCursor(page.nextCursor);
      setLoading(false);
    }).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : 'Payment ledger is unavailable');
      setLoading(false);
    });
  }, []);

  async function loadMore() {
    if (!channelId || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await getPayments(channelId, nextCursor);
      setEntries((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'More payments could not be loaded');
    } finally {
      setLoadingMore(false);
    }
  }

  async function downloadCsv() {
    if (!channelId || exporting) return;
    setExporting(true);
    setError(null);
    try {
      const collected: PaymentLedgerEntry[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_EXPORT_PAGES; page += 1) {
        const result = await getPayments(channelId, cursor, 100);
        collected.push(...result.items);
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }
      const blob = new Blob([toCsv(collected)], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `bharatstudio-payments-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Export could not be prepared');
    } finally {
      setExporting(false);
    }
  }

  if (loading) {
    return (
      <AppShell title="Payments">
        <p className="helper-text" role="status">Loading…</p>
      </AppShell>
    );
  }

  return (
    <AppShell title="Payments">
      <p className="lede" style={{ margin: '0 0 24px' }}>Raw payment and refund records for your channel — owner and admin only.</p>

      {error && <p className="inline-message error-text" role="alert">{error}</p>}

      {!user?.channels.length ? (
        <section className="panel"><p className="helper-text">Create a channel first to see its payment ledger.</p></section>
      ) : !canView ? (
        <section className="panel"><p className="helper-text">Only the channel owner or an admin can view the payment ledger.</p></section>
      ) : (
        <section className="panel" aria-labelledby="ledger-title">
          <div className="panel-heading">
            <div><p className="muted-label">Ledger</p><h2 id="ledger-title">{entries.length} payment{entries.length === 1 ? '' : 's'} loaded</h2></div>
            <button type="button" className="secondary-button" onClick={() => void downloadCsv()} disabled={exporting || entries.length === 0}>
              {exporting ? 'Preparing…' : 'Download CSV'}
            </button>
          </div>
          {entries.length === 0 ? (
            <p className="helper-text">No payments yet.</p>
          ) : (
            <div className="payments-table-scroll">
              <table className="payments-table">
                <thead>
                  <tr><th>Date</th><th>Payment ID</th><th>Amount</th><th>Status</th><th>Refunded</th></tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <tr key={entry.paymentId}>
                      <td>{formatDate(entry.createdAt)}</td>
                      <td className="payments-table-id">{entry.providerPaymentId}</td>
                      <td>{formatMoney(entry.grossAmountPaise)}</td>
                      <td className="payments-table-status">{statusLabel(entry.status)}</td>
                      <td>{entry.refundTotalPaise > 0 ? `${formatMoney(entry.refundTotalPaise)} · ${statusLabel(entry.latestRefundStatus ?? '')}` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {nextCursor && (
            <button type="button" className="secondary-button payments-load-more" onClick={() => void loadMore()} disabled={loadingMore}>
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          )}
        </section>
      )}
    </AppShell>
  );
}
