/*
 * Placeholder primitive for the app's near-universal `<label>Text<input/>
 * </label>` shape. Renders exactly that DOM — JSX strips the whitespace
 * between the label text and the child element the same way the original
 * inline markup did, so this is a pure structural wrapper, not new markup.
 */
import type { ReactNode } from 'react';

export function Field({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return <label className={className}>{label}{children}</label>;
}
