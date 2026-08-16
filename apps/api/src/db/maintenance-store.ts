import type { Sql, TransactionSql } from 'postgres';
import type { MaintenanceRequest, MaintenanceResult, MaintenanceStore } from '../domain/maintenance.js';

type MaintenanceRunRow = {
  run_id: string;
  job: MaintenanceRequest['job'];
  status: MaintenanceResult['status'];
};

// Two security-definer job-implementation functions, both following the
// same accept_maintenance_run(job, key, window) -> run_<job>_maintenance
// (run_id) two-phase protocol 0016 established. A plain switch (not a
// dynamic function-name interpolation) keeps the actually-executed SQL
// statically visible and avoids any identifier-interpolation risk.
async function runJobImplementation(tx: TransactionSql, job: MaintenanceRequest['job'], runId: string): Promise<MaintenanceRunRow[]> {
  switch (job) {
    case 'overlay-sessions':
      return tx<MaintenanceRunRow[]>`select run_id, job, status from app_private.run_overlay_session_maintenance(${runId}::uuid)`;
    case 'overlay-expiry-reminder':
      return tx<MaintenanceRunRow[]>`select run_id, job, status from app_private.run_overlay_expiry_reminder_maintenance(${runId}::uuid)`;
    default:
      throw new Error(`Maintenance job is owned by another service: ${job}`);
  }
}

export function createSqlMaintenanceStore(sql: Sql): MaintenanceStore {
  return {
    async execute(request) {
      if (request.job !== 'overlay-sessions' && request.job !== 'overlay-expiry-reminder') {
        throw new Error(`Maintenance job is owned by another service: ${request.job}`);
      }

      return sql.begin(async (tx) => {
        const acceptedRows = await tx<MaintenanceRunRow[]>`
          select run_id, job, status
            from app_private.accept_maintenance_run(
              ${request.job}, ${request.idempotencyKey}, ${request.window ?? null}
            )
        `;
        const accepted = acceptedRows[0];
        if (!accepted) throw new Error('Maintenance run was not accepted');

        if (accepted.status === 'already_completed') {
          return {
            schemaVersion: 'v1' as const,
            job: accepted.job,
            status: accepted.status,
            runId: accepted.run_id,
          };
        }

        const completedRows = await runJobImplementation(tx, request.job, accepted.run_id);
        const completed = completedRows[0];
        if (!completed) throw new Error(`${request.job} maintenance did not complete`);
        return {
          schemaVersion: 'v1' as const,
          job: completed.job,
          status: completed.status,
          runId: completed.run_id,
        };
      });
    },
  };
}
