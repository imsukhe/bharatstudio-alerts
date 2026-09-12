import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import type { ChallengeKind, ChallengeState, OverlayChallenge, OverlayChallengeStore } from '../domain/challenge-store.js';

// Mirrors apps/api/src/db/goal-overlay-store.ts exactly: sha256
// fingerprint of the bearer token, matched against overlay_sessions'
// stored token_fingerprint inside the security-definer function. Same
// overlay_sessions table, same scoping — no second auth mechanism.
function fingerprint(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function createSqlChallengeOverlayStore(sql: Sql): OverlayChallengeStore {
  return {
    async getForOverlay(token, overlayId): Promise<OverlayChallenge | null> {
      const rows = await sql<{
        challenge_id: string; title: string; challenge_kind: ChallengeKind; target_amount_paise: string | number;
        state: ChallengeState; progress_paise: string | number; target_reached: boolean;
      }[]>`
        select challenge_id, title, challenge_kind, target_amount_paise, state, progress_paise, target_reached
          from app_private.list_overlay_challenge(${overlayId}::uuid, ${fingerprint(token)})
      `;
      const row = rows[0];
      if (!row) return null;
      return {
        schemaVersion: 'v1',
        challengeId: row.challenge_id,
        title: row.title,
        kind: row.challenge_kind,
        targetAmountPaise: Number(row.target_amount_paise),
        state: row.state,
        progressPaise: Number(row.progress_paise),
        targetReached: row.target_reached,
      };
    },
  };
}
