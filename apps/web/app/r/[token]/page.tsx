import { TopNav } from '../../components/TopNav';
import { loadReceipt } from './receipt-loader';

function formatPaise(paise: number): string {
  return `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;
}

// Level-1 viewer receipt (master plan 10.3 item 9): /r/<token>. Works with
// NO viewer account or login at all — the token is an opaque fingerprint
// match only (migration 0107), never a stand-in for authentication and
// never anything a tipper could forge to view someone else's receipt.
export default async function ReceiptPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const load = await loadReceipt(process.env.API_ORIGIN, token, fetch);

  return (
    <main className="public-shell">
      <TopNav />
      <section className="tip-card" aria-labelledby="receipt-title">
        {load.state === 'found' && load.receipt.state === 'found' ? (
          <div className="tipintent-confirm">
            <p className="creator-mark" aria-hidden="true">{load.receipt.channelDisplayName.slice(0, 1).toUpperCase()}</p>
            <h1 id="receipt-title" className="eyebrow">Support for {load.receipt.channelDisplayName}</h1>
            {load.receipt.donorDisplayName ? <p className="tipintent-donor">from {load.receipt.donorDisplayName}</p> : null}
            <p className="tipintent-amount">{formatPaise(load.receipt.netAmountPaise)}</p>
            {load.receipt.refundedAmountPaise > 0 ? (
              <p className="inline-message" role="status">
                {formatPaise(load.receipt.grossAmountPaise)} paid, {formatPaise(load.receipt.refundedAmountPaise)} refunded
              </p>
            ) : null}
            {load.receipt.message ? <p className="tipintent-message">&ldquo;{load.receipt.message}&rdquo;</p> : null}
            <p className="inline-message" role="status">{new Date(load.receipt.paidAt).toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
          </div>
        ) : load.state === 'not_found' ? (
          <>
            <h1 id="receipt-title">Receipt not found</h1>
            <p className="lede">This receipt link doesn&rsquo;t exist. Double check what was shared with you.</p>
          </>
        ) : (
          <>
            <h1 id="receipt-title">Temporarily unavailable</h1>
            <p className="lede">This receipt can&rsquo;t be checked right now. Please try again in a moment.</p>
          </>
        )}
      </section>
    </main>
  );
}
