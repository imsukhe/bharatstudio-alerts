import { redirect } from 'next/navigation';
import { TopNav } from '../../components/TopNav';
import { TipForm } from './TipForm';
import { loadPublicChannel } from './public-channel-loader';

export default async function PublicTipsPage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const result = await loadPublicChannel(process.env.API_ORIGIN, handle, fetch);
  // The requested handle was released in a rename and the API resolved it
  // to the channel's current handle (renamedFrom is only ever set in that
  // case — see public-channel-contract.ts). Land the visitor on the real,
  // canonical URL via an HTTP redirect rather than silently rendering the
  // current channel's content under the old, dead handle.
  if (result.state === 'ready' && result.channel.renamedFrom) {
    redirect(`/tips/${encodeURIComponent(result.channel.handle)}`);
  }
  const channel = result.state === 'ready' ? result.channel : undefined;
  const displayName = channel?.displayName ?? handle;
  const acceptingTips = channel?.acceptingTips ?? false;
  const minimumTipPaise = channel?.minimumTipPaise ?? 1000;
  const stateMessage = result.state === 'ready'
    ? acceptingTips ? 'Tips are open' : 'Tips are currently closed'
    : result.state === 'not_found'
      ? 'Creator page not found'
      : 'Tips are temporarily unavailable';

  return (
    <main className="public-shell">
      <TopNav />
      <section className="tip-card" aria-labelledby="tip-title">
        <div className="creator-mark" aria-hidden="true">{displayName.slice(0, 1).toUpperCase()}</div>
        <p className="eyebrow">Support the stream</p>
        <h1 id="tip-title">Send a tip to {displayName}</h1>
        <p className="lede">Your message can appear in the creator’s approved alert experience.</p>
        <div className="tip-state" role="status">
          <span className={`state-dot ${acceptingTips ? 'is-live' : ''}`} aria-hidden="true" />
          {stateMessage}
        </div>
        <TipForm handle={handle} acceptingTips={acceptingTips} minimumTipPaise={minimumTipPaise} />
      </section>
    </main>
  );
}
