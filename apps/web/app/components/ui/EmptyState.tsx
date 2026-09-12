/*
 * Placeholder primitive for the app's one-line "nothing here yet" text —
 * e.g. Alerts' "No queues yet.", Mod console's "No alerts yet.", Payments'
 * "No payments yet." Most call sites render a plain <p>; a few (Payments,
 * BindingControls) add `helper-text`. Defaults to plain to match the
 * most-used form; pass `helper` for the others.
 */
import type { ReactNode } from 'react';

export function EmptyState({ children, helper = false }: { children: ReactNode; helper?: boolean }) {
  return <p className={helper ? 'helper-text' : undefined}>{children}</p>;
}
