'use client';

/*
 * Dashboard Overview — trimmed to a summary + quick-links surface now that
 * the full editors live on their own routes (/dashboard/alerts, /customise,
 * /mod, /billing, /referrals — see AppShell's nav). This mirrors legacy's
 * dashboard/page.tsx, which was also just a summary shell over a sidebar of
 * dedicated pages, not one page holding every control.
 *
 * The inline Companion queue controls (target-queue selector plus pause/
 * resume/send-test buttons) are kept here, not just a promo link to
 * /companion — they were real working functionality on the pre-split
 * dashboard, not decorative, so trimming this page down to a summary must
 * not silently drop them. /companion remains the fuller page (overlay
 * health, history, sessions, notifications); this is the quick version for
 * "I'm already on Overview and just need to pause the queue."
 */
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { executeCompanionAction, getBilling, getChannel, getCompanionState, getCurrentUser, getQueues, getTermsStatus, type BillingView, type ChannelDetails, type CompanionAction, type CompanionState, type CurrentUser, type Queue } from '../lib/api';

function formatPlanPrice(monthlyPricePaise: number): string {
  return monthlyPricePaise === 0 ? 'Free' : `₹${Math.round(monthlyPricePaise / 100).toLocaleString('en-IN')}/month`;
}

export default function DashboardClient() {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [channel, setChannel] = useState<ChannelDetails | null>(null);
  const [billing, setBilling] = useState<BillingView | null>(null);
  const [companion, setCompanion] = useState<CompanionState | null>(null);
  const [queues, setQueues] = useState<Queue[]>([]);
  const [selectedCompanionQueueId, setSelectedCompanionQueueId] = useState<string | null>(null);
  // Success and failure used to share one `message` string rendered through
  // the same gold `inline-message`/role="status" treatment — a screen
  // reader got the same "polite" announcement for both, and a sighted user
  // got no color distinction. `messageKind` lets the render pick between
  // that and the app's existing error-text/role="alert" treatment.
  const [message, setMessage] = useState<string | null>(null);
  const [messageKind, setMessageKind] = useState<'success' | 'error'>('success');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getTermsStatus().then((status) => {
      if (!status.accepted) { window.location.assign('/accept-terms'); return; }
      loadDashboard();
    }).catch(() => {
      // Terms status couldn't be confirmed — fail toward the gate rather
      // than silently rendering a dashboard whose mutations the backend
      // will reject.
      window.location.assign('/accept-terms');
    });

    function loadDashboard() {
      getCurrentUser().then(async (nextUser) => {
        setUser(nextUser);
        const first = nextUser.channels[0];
        // No channel yet — onboarding hasn't been completed. Redirect there
        // rather than rendering an inline create-channel form here too;
        // channel creation now has exactly one home (/onboarding/step-1),
        // which is also what makes it correctly resumable after sign-out.
        if (!first) { window.location.assign('/onboarding'); return; }
        const [nextChannel, billingView, companionState, nextQueues] = await Promise.all([getChannel(first.channelId), getBilling(first.channelId), getCompanionState(first.channelId), getQueues(first.channelId)]);
        setChannel(nextChannel); setBilling(billingView); setCompanion(companionState); setQueues(nextQueues.queues);
        setSelectedCompanionQueueId(nextQueues.queues.find((queue) => queue.active)?.queueId ?? null);
      }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Account data is unavailable'));
    }
  }, []);

  const canOperateQueues = channel ? ['owner', 'admin', 'operator'].includes(channel.role ?? '') : false;

  async function sendCompanionAction(action: CompanionAction) {
    if (!channel) return;
    const target = queues.find((queue) => queue.queueId === selectedCompanionQueueId && queue.active) ?? queues.find((queue) => queue.active);
    if (!target) { setMessage('Companion controls are unavailable until an active queue is loaded.'); setMessageKind('error'); return; }
    try { await executeCompanionAction(channel.channelId, action, target.queueId); setMessage('Companion command accepted.'); setMessageKind('success'); }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Companion command could not be accepted'); setMessageKind('error'); }
  }

  if (error) {
    return <div className="panel"><p className="error-text" role="alert">{error}</p><Link className="text-link" href="/login">Return to sign in →</Link></div>;
  }
  if (!user) return <div className="panel" role="status">Loading your channels…</div>;

  return (
    <>
      <section className="panel welcome-panel">
        <p className="muted-label">Signed in</p>
        <h2>{user.displayName ? `Welcome, ${user.displayName}.` : 'Welcome to your dashboard.'}</h2>
        <p>Your account is connected through the reviewed authentication flow.</p>
      </section>

      {message && (messageKind === 'error'
        ? <p className="inline-message error-text" role="alert">{message}</p>
        : <p className="inline-message" role="status">{message}</p>)}

      {!channel ? (
        <section className="panel" role="status">Loading your channel…</section>
      ) : (
        <>
          <section className="panel channel-overview">
            <div>
              <p className="muted-label">Selected channel</p>
              <h2>{channel.displayName}</h2>
              <p className="handle">@{channel.handle} · {channel.acceptingTips ? 'Tips open' : 'Tips closed'} · {billing?.tier ?? 'Plan loading'}</p>
            </div>
            <Link className="primary-button" href={`/tips/${channel.handle}`} target="_blank" rel="noreferrer">Open public page</Link>
          </section>

          {billing && (
            <section className="panel" aria-labelledby="billing-summary-title">
              <div className="panel-heading">
                <div>
                  <p className="muted-label">Billing</p>
                  <h2 id="billing-summary-title">{billing.tier[0].toUpperCase() + billing.tier.slice(1)} · {formatPlanPrice(billing.monthlyPricePaise)}</h2>
                </div>
                <Link className="secondary-button" href="/dashboard/billing">Manage billing →</Link>
              </div>
              <p className="helper-text">{billing.renewalState === 'not_applicable' ? 'No recurring subscription' : billing.renewalState.replaceAll('_', ' ')} · {billing.autoRenew ? 'Auto-renew on' : 'Auto-renew off'}</p>
            </section>
          )}

          <section className="content-grid">
            <article className="panel">
              <div className="panel-heading"><div><p className="muted-label">Quick links</p><h2>Configure your stream</h2></div></div>
              <div className="channel-list">
                <Link className="channel-row" href="/dashboard/alerts"><div><strong>Alerts</strong><span>Amount brackets, TTS, queues and test alerts</span></div><span aria-hidden="true">→</span></Link>
                <Link className="channel-row" href="/dashboard/customise"><div><strong>Customise</strong><span>Custom Lottie alert animations, per display style</span></div><span aria-hidden="true">→</span></Link>
                <Link className="channel-row" href="/dashboard/mod"><div><strong>Mod console</strong><span>Recent alerts, approve/hold/suppress/replay</span></div><span aria-hidden="true">→</span></Link>
                <Link className="channel-row" href="/dashboard/referrals"><div><strong>Referrals</strong><span>Invite creators, earn service time</span></div><span aria-hidden="true">→</span></Link>
              </div>
            </article>
            <article className="panel companion-panel">
              <div>
                <p className="muted-label">Web Companion</p>
                <h2>Broadcast controls</h2>
                <p>{companion?.overlayConnected ? 'Overlay connected' : 'Overlay not connected'} · {companion?.pendingAlerts ?? 0} pending alerts</p>
              </div>
              {canOperateQueues ? (
                <>
                  <label>Target queue
                    <select value={selectedCompanionQueueId ?? ''} onChange={(event) => setSelectedCompanionQueueId(event.target.value || null)}>
                      <option value="">Select an active queue</option>
                      {queues.filter((queue) => queue.active).map((queue) => <option key={queue.queueId} value={queue.queueId}>{queue.name}{queue.paused ? ' · paused' : ''}</option>)}
                    </select>
                  </label>
                  {queues.some((queue) => queue.active) ? (
                    <div className="control-actions">
                      <button className="secondary-button" type="button" onClick={() => sendCompanionAction('pause_queue')}>Pause queue</button>
                      <button className="secondary-button" type="button" onClick={() => sendCompanionAction('resume_queue')}>Resume queue</button>
                      <button className="secondary-button" type="button" onClick={() => sendCompanionAction('send_test_alert')}>Send test</button>
                    </div>
                  ) : <p className="helper-text">Controls are unavailable until an active queue is loaded.</p>}
                </>
              ) : <p className="helper-text">Your channel role can view Companion state but cannot issue broadcast controls.</p>}
              <Link className="text-link" href="/companion">Open full Companion console →</Link>
            </article>
          </section>

          <section className="panel channel-panel" aria-labelledby="channels-title">
            <div className="panel-heading"><div><p className="muted-label">Your channels</p><h2 id="channels-title">Channel access</h2></div></div>
            <div className="channel-list">{user.channels.map((candidate) => <div className="channel-row" key={candidate.channelId}><div><strong>{candidate.channelId}</strong><span>{candidate.role}</span></div><Link className="text-link" href={`/overlay/setup?channelId=${encodeURIComponent(candidate.channelId)}`}>Configure →</Link></div>)}</div>
          </section>
        </>
      )}
    </>
  );
}
