'use client';
import { WidgetPoller } from '../../shared/WidgetPoller';
import { isSupporterTicker } from '../../l16-widget-data';
export default function SupporterTickerWidgetPage() { return <WidgetPoller endpoint="supporter-ticker" field="entries" isValid={isSupporterTicker} render={(entries) => entries.length ? <section className="l16-widget-card l16-widget-ticker" aria-live="polite">{entries.map((entry) => <span key={`${entry.viewerRef}-${entry.supportedAt}`}>{entry.viewerRef} · {entry.tierLabel}</span>)}</section> : null} />; }
