import type { Sql } from 'postgres';
import type { MaintenanceRequest, MaintenanceResult, MaintenanceStore } from '../domain/maintenance.js';

type MaintenanceRunRow = {
  run_id: string;
  job: MaintenanceRequest['job'];
  status: MaintenanceResult['status'];
};

export function createSqlMaintenanceStore(sql: Sql): MaintenanceStore {
  return {
    async execute(request) {
      if (request.job !== 'overlay-sessions') {
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

        const completedRows = await tx<MaintenanceRunRow[]>`
          select run_id, job, status
            from app_private.run_overlay_session_maintenance(${accepted.run_id}::uuid)
        `;
        const completed = completedRows[0];
        if (!completed) throw new Error('Overlay-session maintenance did not complete');
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
