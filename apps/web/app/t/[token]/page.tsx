import { TopNav } from '../../components/TopNav';
import { loadTipIntent } from './tipintent-loader';
import { TipIntentConfirm } from './TipIntentConfirm';

// The opaque !tip short link (master plan L15 task 8): /t/<token>. No
// query parameters are ever read here — the token is the only input, and
// everything else (amount, name, message, who it's for) comes back from
// GET /v1/public/tip-intents/:token, keyed server-side by the token. A
// viewer cannot edit this URL to change what the creator receives.
export default async function TipIntentPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const load = await loadTipIntent(process.env.API_ORIGIN, token, fetch);

  return (
    <main className="public-shell">
      <TopNav />
      <section className="tip-card" aria-labelledby="tipintent-title">
        {load.state === 'ready' && load.intent.state === 'ready' ? (
          <>
            <h1 id="tipintent-title">Confirm your support</h1>
            <TipIntentConfirm
              token={token}
              channelDisplayName={load.intent.channelDisplayName}
              amountPaise={load.intent.amountPaise}
              donorDisplayName={load.intent.donorDisplayName}
              message={load.intent.message}
            />
          </>
        ) : load.state === 'used' && load.intent.state === 'used' ? (
          <>
            <h1 id="tipintent-title">Already used</h1>
            <p className="lede">This support link for {load.intent.channelDisplayName} has already been used. Chat commands like <code>!tip</code> create a new one-time link each time — ask in chat for a fresh one.</p>
          </>
        ) : load.state === 'expired' && load.intent.state === 'expired' ? (
          <>
            <h1 id="tipintent-title">Link expired</h1>
            <p className="lede">This support link for {load.intent.channelDisplayName} has expired. Support links are short-lived for security — type <code>!tip</code> again in chat to get a new one.</p>
          </>
        ) : load.state === 'unknown' ? (
          <>
            <h1 id="tipintent-title">Link not found</h1>
            <p className="lede">This support link doesn&rsquo;t exist. Double check what was typed, or ask in chat for a fresh one.</p>
          </>
        ) : (
          <>
            <h1 id="tipintent-title">Temporarily unavailable</h1>
            <p className="lede">This support link can&rsquo;t be checked right now. Please try again in a moment.</p>
          </>
        )}
      </section>
    </main>
  );
}
