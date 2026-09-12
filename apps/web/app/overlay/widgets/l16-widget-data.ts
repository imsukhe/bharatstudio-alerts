export type RecentTip = { displayName: string; amountPaise: number; message: string | null; createdAt: string };
export type TopSupporter = { rank: number; viewerRef: string; tierLabel: string };
export type SupporterTickerEntry = { viewerRef: string; tierLabel: string; supportedAt: string };
export type MegaTip = { displayName: string; amountPaise: number; createdAt: string };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function exactKeys(row: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(row).length === keys.length && keys.every((key) => Object.hasOwn(row, key));
}

export function isRecentTips(value: unknown): value is RecentTip[] {
  return Array.isArray(value) && value.every((item) => {
    const row = record(item);
    return row && exactKeys(row, ['displayName', 'amountPaise', 'message', 'createdAt']) && typeof row.displayName === 'string' && typeof row.amountPaise === 'number'
      && (typeof row.message === 'string' || row.message === null) && typeof row.createdAt === 'string';
  });
}

export function isTopSupporters(value: unknown): value is TopSupporter[] {
  return Array.isArray(value) && value.every((item) => {
    const row = record(item);
    return row && exactKeys(row, ['rank', 'viewerRef', 'tierLabel']) && typeof row.rank === 'number' && typeof row.viewerRef === 'string' && typeof row.tierLabel === 'string';
  });
}

export function isSupporterTicker(value: unknown): value is SupporterTickerEntry[] {
  return Array.isArray(value) && value.every((item) => {
    const row = record(item);
    return row && exactKeys(row, ['viewerRef', 'tierLabel', 'supportedAt']) && typeof row.viewerRef === 'string' && typeof row.tierLabel === 'string' && typeof row.supportedAt === 'string';
  });
}

export function isMegaTip(value: unknown): value is MegaTip | null {
  if (value === null) return true;
  const row = record(value);
  return !!row && exactKeys(row, ['displayName', 'amountPaise', 'createdAt']) && typeof row.displayName === 'string' && typeof row.amountPaise === 'number' && typeof row.createdAt === 'string';
}

export function formatRupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN')}`;
}
