/*
 * Modeled on Payments' `.payments-table` — the only real HTML <table> in
 * the app — and now wired into apps/web/app/payments/page.tsx, which was
 * its only intended use; default className/scrollClassName reproduce that
 * page's exact prior markup. Not used by Alerts/Settings: both are
 * div-based rows (queue-list, channel-list, status-list), and rendering
 * those through a <table> would change the DOM, not just seam it.
 */
import type { ReactNode } from 'react';

export type DataTableColumn<T> = {
  header: ReactNode;
  render: (row: T) => ReactNode;
  className?: string;
};

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  className = 'payments-table',
  scrollClassName = 'payments-table-scroll',
}: {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  className?: string;
  scrollClassName?: string;
}) {
  return (
    <div className={scrollClassName}>
      <table className={className}>
        <thead>
          <tr>{columns.map((column, index) => <th key={index}>{column.header}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((column, index) => <td key={index} className={column.className}>{column.render(row)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
