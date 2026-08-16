export const maintenanceJobs = [
  'payment-reconcile',
  'refund-reconcile',
  'outbox-recover',
  'overlay-sessions',
  'event-archive',
  'audit-archive',
  'overlay-expiry-reminder',
  'referral-lifecycle',
] as const;

export type MaintenanceJob = typeof maintenanceJobs[number];

export type MaintenanceRequest = {
  job: MaintenanceJob;
  idempotencyKey: string;
  window?: string;
};

export type MaintenanceResult = {
  schemaVersion: 'v1';
  job: MaintenanceJob;
  status: 'accepted' | 'completed' | 'already_completed';
  runId: string;
};

export interface MaintenanceStore {
  execute(request: MaintenanceRequest): Promise<MaintenanceResult>;
}

export interface ServiceIdentityVerifier {
  verify(authorizationHeader: string | undefined): Promise<boolean>;
}
