/*
 * Placeholder primitive for `.panel` — the app's one content-block shape,
 * used as both <section> (most panels) and <article> (Alerts' queue/test
 * panels, DashboardClient's channel panels). Two heading layouts exist
 * today and both are preserved exactly:
 *  - heading="wrapped" (default): eyebrow + <h2> inside a `.panel-heading`
 *    div, optionally with trailing actions — Billing, Referrals, Mod,
 *    Settings.
 *  - heading="bare": eyebrow + <h2> as direct children with no wrapping
 *    div — Alerts' Queues/Test alert panels.
 * `helper` renders the optional leading `.helper-text` paragraph some
 * panels open with (e.g. Alerts' binding panel, Billing).
 */
import type { ElementType, ReactNode } from 'react';
import { PageHeader } from './PageHeader';

export function Card({
  as: As = 'section',
  eyebrow,
  title,
  titleId,
  actions,
  heading = 'wrapped',
  helper,
  ariaLabel,
  className,
  children,
}: {
  as?: ElementType;
  eyebrow?: ReactNode;
  title?: ReactNode;
  titleId?: string;
  actions?: ReactNode;
  heading?: 'wrapped' | 'bare' | 'none';
  helper?: ReactNode;
  ariaLabel?: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <As className={className ? `panel ${className}` : 'panel'} aria-labelledby={titleId} aria-label={ariaLabel}>
      {heading === 'wrapped' && <PageHeader eyebrow={eyebrow} title={title} titleId={titleId} actions={actions} />}
      {heading === 'bare' && (
        <>
          {eyebrow && <p className="muted-label">{eyebrow}</p>}
          {title && <h2 id={titleId}>{title}</h2>}
        </>
      )}
      {helper && <p className="helper-text">{helper}</p>}
      {children}
    </As>
  );
}
