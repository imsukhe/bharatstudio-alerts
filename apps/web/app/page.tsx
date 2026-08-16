import Link from 'next/link';
import { TopNav } from './components/TopNav';

export default function AlertsHomePage() {
  return (
    <main className="page-shell">
      <TopNav />
      <section className="dashboard-heading">
        <div>
          <p className="eyebrow">BharatStudio Alerts</p>
          <h1>Your stream. Your alerts. Your control.</h1>
          <p className="lede">
            Durable tip alerts, a browser-source overlay and creator dashboard —
            sign in with Google to create your channel and start accepting tips.
          </p>
          <div className="control-actions" style={{ marginTop: 24 }}>
            <Link className="primary-button" href="/login">Sign in to get started</Link>
            <Link className="secondary-button" href="/dashboard">Go to dashboard</Link>
          </div>
        </div>
      </section>
      <section className="metric-grid" aria-label="What Alerts gives you">
        <article className="metric-card">
          <p className="muted-label">Public tip page</p>
          <strong>0% commission</strong>
          <p>Fans tip directly through Razorpay; nothing routes through BharatStudio&apos;s own account.</p>
        </article>
        <article className="metric-card">
          <p className="muted-label">Browser-source overlay</p>
          <strong>Durable delivery</strong>
          <p>Alerts replay after a reconnect — an accepted tip is never silently dropped.</p>
        </article>
        <article className="metric-card">
          <p className="muted-label">Creator dashboard</p>
          <strong>Full control</strong>
          <p>Queues, moderation, billing, referrals and branding, all in one place.</p>
        </article>
      </section>
    </main>
  );
}
