import type { TransactionSql } from 'postgres';
import type { RetentionJob } from '../domain/retention-policy.js';

// Thin wrappers around the three retention-sweep SQL functions added in
// migration 0095. Each follows the same two-phase maintenance protocol as
// every other job (see maintenance-store.ts): accept_maintenance_run has
// already inserted/claimed the run row before any of these is called.
export type RetentionMaintenanceRow = {
  run_id: string;
  job: RetentionJob;
  status: 'completed' | 'already_completed';
  removed_count: number;
};

export async function runCompanionPairingRetentionMaintenance(tx: TransactionSql, runId: string): Promise<RetentionMaintenanceRow[]> {
  return tx<RetentionMaintenanceRow[]>`
    select run_id, job, status, removed_count
      from app_private.run_retention_companion_pairings_maintenance(${runId}::uuid)
  `;
}

export async function runYoutubeOauthStateRetentionMaintenance(tx: TransactionSql, runId: string): Promise<RetentionMaintenanceRow[]> {
  return tx<RetentionMaintenanceRow[]>`
    select run_id, job, status, removed_count
      from app_private.run_retention_youtube_oauth_states_maintenance(${runId}::uuid)
  `;
}

export async function runViewerResetTokenRetentionMaintenance(tx: TransactionSql, runId: string): Promise<RetentionMaintenanceRow[]> {
  return tx<RetentionMaintenanceRow[]>`
    select run_id, job, status, removed_count
      from app_private.run_retention_viewer_reset_tokens_maintenance(${runId}::uuid)
  `;
}
