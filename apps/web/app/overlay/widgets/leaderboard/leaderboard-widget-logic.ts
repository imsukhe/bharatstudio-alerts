/*
 * Pure, DOM-free helpers for the leaderboard overlay widget. The row shape
 * itself is the privacy proof: it structurally carries no amount field —
 * see packages/db/migrations/0105's channel_leaderboard function and this
 * type's own fields (rank + tierLabel only).
 */

export type OverlayLeaderboardRow = { rank: number; viewerRef: string; tierLabel: string };
export type OverlayLeaderboard = { schemaVersion: 'v1'; window: 'weekly' | 'monthly' | 'all'; rows: OverlayLeaderboardRow[] };

export function isOverlayLeaderboard(value: unknown): value is OverlayLeaderboard {
  if (!isExactRecord(value, ['schemaVersion', 'window', 'rows']) || value.schemaVersion !== 'v1'
    || (value.window !== 'weekly' && value.window !== 'monthly' && value.window !== 'all')
    || !Array.isArray(value.rows) || value.rows.length > 100) return false;
  return value.rows.every((row) => {
    return isExactRecord(row, ['rank', 'viewerRef', 'tierLabel'])
      && isNonNegativeSafeInteger(row.rank) && row.rank > 0
      && isBoundedString(row.viewerRef, 128) && isBoundedString(row.tierLabel, 80);
  });
}
import { isBoundedString, isExactRecord, isNonNegativeSafeInteger } from '../shared/response-validation';
