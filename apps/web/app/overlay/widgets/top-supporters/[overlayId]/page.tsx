'use client';
import { WidgetPoller } from '../../shared/WidgetPoller';
import { isTopSupporters } from '../../l16-widget-data';
export default function TopSupportersWidgetPage() { return <WidgetPoller endpoint="top-supporters" field="supporters" isValid={isTopSupporters} render={(supporters) => supporters.length ? <section className="l16-widget-card" aria-live="polite"><strong>Top supporters</strong>{supporters.map((supporter) => <p key={supporter.viewerRef}>#{supporter.rank} · {supporter.tierLabel}</p>)}</section> : null} />; }
