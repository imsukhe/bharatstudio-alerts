// CTL-10/CTL-11 (migration 0160): the staff-only publish surface behind
// GET /v1/public/capability-matrix, and the webhook trigger CTL-11
// requires ("the marketing build reads the snapshot; webhook
// revalidation"). Platform-staff only (app_private.is_platform_admin()),
// same gate every other capability-plane admin surface in this codebase
// uses -- see domain/capability-registry-admin.ts.

export type CapabilityMatrixSnapshotSummary = {
  schemaVersion: 'v1';
  id: string;
  version: number;
  publishedAt: string;
  publishedBy: string | null;
  reason: string | null;
  rowCount: number;
};

// A fixed, small set of business-rule outcomes the SQL layer can raise --
// mirrors CapabilityRegistryAdminError's own shape
// (domain/capability-registry-admin.ts). Today the only one is the
// platform-admin gate itself, which the route's pre-handler already
// intercepts before the store is ever called -- kept as a real type
// (not `never`) so a future SQL-side business rule (e.g. a rate limit on
// publish frequency) has somewhere to land without a route-layer change.
export type CapabilityMatrixAdminErrorReason = 'invalid_input';

export class CapabilityMatrixAdminError extends Error {
  readonly reason: CapabilityMatrixAdminErrorReason;
  constructor(reason: CapabilityMatrixAdminErrorReason, message: string) {
    super(message);
    this.name = 'CapabilityMatrixAdminError';
    this.reason = reason;
  }
}

export interface CapabilityMatrixAdminStore {
  publish(userId: string, reason: string): Promise<CapabilityMatrixSnapshotSummary>;
  listSnapshots(userId: string): Promise<CapabilityMatrixSnapshotSummary[]>;
}
