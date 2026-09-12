/*
 * Placeholder primitive — a structural seam for the later visual redesign,
 * not a new design. Renders exactly today's `.primary-button` /
 * `.secondary-button` markup; no new styling or CSS custom properties.
 * `type` is left to the caller (as every existing button call site already
 * sets it explicitly) so omitting it keeps the native default, unchanged.
 */
import type { ButtonHTMLAttributes } from 'react';

export function Button({
  variant = 'secondary',
  className,
  ...props
}: { variant?: 'primary' | 'secondary' } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const base = variant === 'primary' ? 'primary-button' : 'secondary-button';
  return <button className={className ? `${base} ${className}` : base} {...props} />;
}
