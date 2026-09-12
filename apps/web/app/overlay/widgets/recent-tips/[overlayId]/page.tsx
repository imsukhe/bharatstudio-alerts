'use client';
import { WidgetPoller } from '../../shared/WidgetPoller';
import { formatRupees, isRecentTips } from '../../l16-widget-data';
export default function RecentTipsWidgetPage() { return <WidgetPoller endpoint="recent-tips" field="tips" isValid={isRecentTips} render={(tips) => tips.length ? <section className="l16-widget-card" aria-live="polite"><strong>Recent tips</strong>{tips.map((tip) => <p key={`${tip.createdAt}-${tip.displayName}`}>{tip.displayName} · {formatRupees(tip.amountPaise)}{tip.message ? ` — ${tip.message}` : ''}</p>)}</section> : null} />; }
