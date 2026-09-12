'use client';
import { WidgetPoller } from '../../shared/WidgetPoller';
import { formatRupees, isMegaTip } from '../../l16-widget-data';
export default function MegaTipBannerWidgetPage() { return <WidgetPoller endpoint="mega-tip-banner" field="banner" isValid={isMegaTip} render={(banner) => banner ? <section className="l16-widget-card" aria-live="polite"><strong>Mega tip!</strong> {banner.displayName} · {formatRupees(banner.amountPaise)}</section> : null} />; }
