'use client';

/*
 * Self-serve referral dashboard — v1 scope addendum item. Reads
 * GET /v1/channels/:id/referrals/overview and GET /v1/channels/:id/
 * referrals (database-enforced owner/admin-only via has_channel_role; a
 * non-owner/admin caller gets an empty result here, not an error). The
 * shareable link is just the channel's own handle as a `?ref=` query
 * param on /login — see lib/referral-capture.ts for how it's picked back
 * up after sign-in. Credits shown here are service-time credits (extra
 * days added to the referrer's own billing period), never a cash amount or
 * a refund — see migration 0076 for the full mechanism.
 */
import { useEffect, useState } from 'react';
import { getReferralHistory, getReferralOverview, type ReferralHistory, type ReferralOverview, type ReferralStatus } from '../lib/api';

type Props = {
  channelId: string;
  handle: string;
};

const STATUS_LABELS: Record<ReferralStatus, string> = {
  pending: 'Pending signup',
  paid_pending_hold: 'In review',
  credited: 'Credited',
  flagged_fraud: 'Flagged',
  revoked: 'Revoked',
  expired: 'Expired',
};

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function ReferralPanel({ channelId, handle }: Props) {
  const [overview, setOverview] = useState<ReferralOverview | null>(null);
  const [history, setHistory] = useState<ReferralHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getReferralOverview(channelId), getReferralHistory(channelId)])
      .then(([nextOverview, nextHistory]) => {
        if (cancelled) return;
        setOverview(nextOverview);
        setHistory(nextHistory);
      })
      .catch((cause) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : 'Referral data is temporarily unavailable');
      });
    return () => { cancelled = true; };
  }, [channelId]);

  const referralLink = typeof window !== 'undefined' ? `${window.location.origin}/login?ref=${encodeURIComponent(handle)}` : `/login?ref=${encodeURIComponent(handle)}`;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(referralLink);
      setCopied(true);
      setError(null);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Matches Overlay setup's equivalent handler for the same failure
      // mode — clipboard access denied by the browser previously failed
      // silently here while the sibling page surfaced a specific message.
      setError('Clipboard access was unavailable; copy the link from the field above.');
    }
  }

  return (
    <div className="referral-panel">
      <div className="referral-link-row">
        <input readOnly value={referralLink} aria-label="Your referral link" onFocus={(event) => event.currentTarget.select()} />
        <button type="button" className="secondary-button" onClick={() => void copyLink()}>{copied ? 'Copied!' : 'Copy link'}</button>
      </div>
      <p className="helper-text">Share this link with other creators. When someone signs up through it and their first subscription payment is confirmed, you earn service-time credit — extra days added to your own plan, not a refund or a cash payout.</p>

      {error && <p className="inline-message error-text" role="alert">{error}</p>}

      {overview && (
        <div className="referral-stats">
          <div className="referral-stat"><strong>{overview.pendingCount}</strong><span>Pending</span></div>
          <div className="referral-stat"><strong>{overview.paidPendingHoldCount}</strong><span>In review</span></div>
          <div className="referral-stat"><strong>{overview.creditedCount}</strong><span>Credited</span></div>
          <div className="referral-stat"><strong>{overview.lifetimeCreditedDays}</strong><span>Lifetime credit days</span></div>
          {overview.bankedCreditDays > 0 && <div className="referral-stat"><strong>{overview.bankedCreditDays}</strong><span>Banked (applies once you're on a paid plan)</span></div>}
        </div>
      )}

      {history && history.items.length > 0 && (
        <table className="referral-history-table">
          <thead><tr><th>Referred</th><th>Status</th><th>Credit</th></tr></thead>
          <tbody>
            {history.items.map((item) => (
              <tr key={item.referralId}>
                <td>{formatDate(item.attributedAt)}</td>
                <td>{STATUS_LABELS[item.status]}</td>
                <td>{item.creditDays ? `${item.creditDays} days` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {history && history.items.length === 0 && <p className="helper-text">No referrals yet — share your link above to get started.</p>}
    </div>
  );
}
