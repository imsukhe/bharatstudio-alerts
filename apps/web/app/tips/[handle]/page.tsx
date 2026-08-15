import { TopNav } from '../../components/TopNav';
import { TipForm } from './TipForm';
import { parsePublicChannel } from '../../lib/public-channel-contract';

type PublicChannel = { displayName: string; acceptingTips: boolean; minimumTipPaise: number };

async function loadChannel(handle: string): Promise<PublicChannel | null> {
  const apiOrigin = process.env.API_ORIGIN;
  if (!apiOrigin) return null;
  try {
    const response = await fetch(`${apiOrigin}/v1/public/channels/${encodeURIComponent(handle)}`, { cache: 'no-store' });
    if (!response.ok) return null;
    const value = parsePublicChannel(await response.json());
    if (!value) return null;
    return { displayName: value.displayName, acceptingTips: value.acceptingTips, minimumTipPaise: value.minimumTipPaise };
  } catch {
    return null;
  }
}

export default async function PublicTipsPage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const channel = await loadChannel(handle);
  const displayName = channel?.displayName ?? handle;
  const acceptingTips = channel?.acceptingTips ?? false;
  const minimumTipPaise = channel?.minimumTipPaise ?? 1000;

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
          {acceptingTips ? 'Tips are open' : 'Tips are currently closed'}
        </div>
        <TipForm handle={handle} acceptingTips={acceptingTips} minimumTipPaise={minimumTipPaise} />
      </section>
    </main>
  );
}
