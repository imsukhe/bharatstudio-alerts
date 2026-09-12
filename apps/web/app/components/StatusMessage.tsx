'use client';

/*
 * Renders the notification set by useStatusMessage. Two variants match the
 * two JSX shapes that existed independently before this extraction:
 *  - 'inline' (default): Alerts, Mod console, DashboardClient —
 *    `<p className="inline-message[ error-text]">`, only rendered when a
 *    message is present.
 *  - 'helper': Companion — `<p className="helper-text[ error-text]">`,
 *    same className regardless of kind except the error-text addition.
 * Both branch `role="alert"` vs `role="status"` on the same kind check.
 */
import type { MessageKind } from '../hooks/useStatusMessage';

export function StatusMessage({
  message,
  kind,
  variant = 'inline',
}: {
  message: string | null;
  kind: MessageKind;
  variant?: 'inline' | 'helper';
}) {
  if (!message) return null;

  if (variant === 'helper') {
    return (
      <p className={kind === 'error' ? 'helper-text error-text' : 'helper-text'} role={kind === 'error' ? 'alert' : 'status'}>
        {message}
      </p>
    );
  }

  return kind === 'error'
    ? <p className="inline-message error-text" role="alert">{message}</p>
    : <p className="inline-message" role="status">{message}</p>;
}
