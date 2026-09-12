import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import type { GoalWindow, OverlayGoal, OverlayGoalStore } from '../domain/goal-store.js';

// Mirrors apps/api/src/db/overlay-branding-store.ts exactly: sha256
// fingerprint of the bearer token, matched against overlay_sessions'
// stored token_fingerprint inside the security-definer function. Same
// overlay_sessions table, same scoping — no second auth mechanism.
function fingerprint(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function createSqlGoalOverlayStore(sql: Sql): OverlayGoalStore {
  return {
    async getForOverlay(token, overlayId): Promise<OverlayGoal | null> {
      const rows = await sql<{
        goal_id: string; title: string; target_amount_paise: string | number; goal_window: GoalWindow;
        progress_paise: string | number; reached: boolean;
      }[]>`
        select goal_id, title, target_amount_paise, goal_window, progress_paise, reached
          from app_private.list_overlay_goal(${overlayId}::uuid, ${fingerprint(token)})
      `;
      const row = rows[0];
      if (!row) return null;
      return {
        schemaVersion: 'v1',
        goalId: row.goal_id,
        title: row.title,
        targetAmountPaise: Number(row.target_amount_paise),
        window: row.goal_window,
        progressPaise: Number(row.progress_paise),
        reached: row.reached,
      };
    },
  };
}
