import Link from 'next/link';
import { TopNav } from '../components/TopNav';
import DashboardClient from './DashboardClient';

const cards = [
  { title: 'Alert activity', value: '—', detail: 'Accepted events will appear here with their durable delivery state.' },
  { title: 'Overlay status', value: 'Not connected', detail: 'Create a scoped browser-source session before adding it to OBS.' },
  { title: 'Current plan', value: '—', detail: 'Plan and entitlement data is resolved server-side.' },
];

export default function DashboardPage() {
  return (
    <main className="page-shell">
      <TopNav />
      <section className="dashboard-heading">
        <div>
          <p className="eyebrow">Creator dashboard</p>
          <h1>Make every alert feel like yours.</h1>
          <p className="lede">Configure queues, preview your alert experience, and keep your stream controls in one place.</p>
        </div>
        <Link className="primary-button" href="/overlay/setup">Set up overlay</Link>
      </section>
      <section className="metric-grid" aria-label="Dashboard summary">
        {cards.map((card) => (
          <article className="metric-card" key={card.title}>
            <p className="muted-label">{card.title}</p>
            <strong>{card.value}</strong>
            <p>{card.detail}</p>
          </article>
        ))}
      </section>
      <DashboardClient />
      <section className="content-grid">
        <article className="panel">
          <div className="panel-heading"><div><p className="muted-label">Next actions</p><h2>Prepare your first stream</h2></div></div>
          <ol className="step-list">
            <li><span>01</span><div><strong>Choose your channel identity</strong><p>Create or select a channel after sign-in.</p></div></li>
            <li><span>02</span><div><strong>Configure the alert experience</strong><p>Set queue behavior, text, sound and visual preferences.</p></div></li>
            <li><span>03</span><div><strong>Add the browser source to OBS</strong><p>Use a short-lived, revocable overlay session.</p></div></li>
          </ol>
        </article>
        <article className="panel accent-panel">
          <p className="muted-label">Web Companion</p>
          <h2>Control the stream without touching the broadcast scene.</h2>
          <p>Approve, hold, replay and pause eligible operations from an authorised companion surface.</p>
          <Link className="text-link" href="/companion">Open Companion Console →</Link>
        </article>
      </section>
    </main>
  );
}
