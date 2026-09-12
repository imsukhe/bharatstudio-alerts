/*
 * Placeholder primitive for the `.panel-heading` shape repeated across
 * Billing, Referrals, Mod console, Alerts' binding panel, DashboardClient
 * and Companion: an eyebrow + heading on the left, optional actions/status
 * on the right. Renders exactly that markup, nothing new.
 */
import type { ReactNode } from 'react';

export function PageHeader({
  eyebrow,
  title,
  titleId,
  actions,
}: {
  eyebrow?: ReactNode;
  title?: ReactNode;
  titleId?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="panel-heading">
      <div>
        {eyebrow && <p className="muted-label">{eyebrow}</p>}
        {title && <h2 id={titleId}>{title}</h2>}
      </div>
      {actions}
    </div>
  );
}
