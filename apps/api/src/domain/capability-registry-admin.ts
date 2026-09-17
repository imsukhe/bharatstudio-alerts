// CTL registry spec alignment (migration 0153): the §20.2 field set
// (kind, limits, beta, marketing_visible, marketing_label,
// marketing_blurb) that migration 0149's own field set (capability_key,
// capacity_class, description, kill_switch, rollout_percentage,
// min_tier) was missing.
//
// This is a DIFFERENT surface from domain/capability-change-management.ts
// (migration 0152's two-staff-approved staged workflow), not a widening
// of it -- see migration 0153's own header for exactly why: 0152's
// staff_get_capability_change/staff_list_capability_changes carry an
// exact-output-column assertion in packages/db/tests/
// ctl_change_management.sql that a widened capability_change_requests
// projection would break, so the six new §20.2 fields are NOT staged/
// approved through that workflow in this migration. They are settable
// only through the single-admin, immediate, still-versioned-and-audited
// path this file backs (app_private.staff_set_capability_registry_entry
// / staff_get_capability_registry_entry / staff_list_capability_registry_entries,
// migration 0153) -- the same "single platform admin, no approval round,
// still fully audited via the registry's own table-level triggers"
// posture app_private.staff_kill_capability_now and
// staff_revert_capability_registry_entry (migration 0152) already use
// for their own immediate writes.
//
// Platform-staff only (app_private.is_platform_admin()) -- same gate
// domain/capability-change-management.ts and admin.ts already use.

export type CapabilityKind = 'widget' | 'module' | 'feature' | 'hub_lane' | 'lobby_mode' | 'ai_feature';

export type CapabilityRegistryEntry = {
  schemaVersion: 'v1';
  capabilityKey: string;
  capacityClass: string;
  description: string;
  killSwitch: boolean;
  rolloutPercentage: number;
  minTier: string | null;
  kind: CapabilityKind | null;
  limits: Record<string, unknown>;
  beta: boolean;
  marketingVisible: boolean;
  marketingLabel: string | null;
  marketingBlurb: string | null;
  version: number;
  updatedAt: string;
  // Present on a read (get/list); absent on the row a write returns --
  // the write functions (migration 0153, mirroring 0149's own
  // staff_upsert_capability_registry_entry) do not project created_at/
  // updated_by, only the read functions do.
  createdAt?: string;
  updatedBy?: string | null;
};

export type SetCapabilityRegistryEntryInput = {
  capabilityKey: string;
  capacityClass: string;
  description: string;
  killSwitch: boolean;
  rolloutPercentage: number;
  minTier: string | null;
  kind: CapabilityKind | null;
  limits: Record<string, unknown>;
  beta: boolean;
  marketingVisible: boolean;
  marketingLabel: string | null;
  marketingBlurb: string | null;
};

// A fixed, small set of business-rule outcomes the SQL layer can raise
// via check_violation (SQLSTATE 23514) -- an unrecognised capacity_class/
// kind/min_tier, a malformed capability_key, or marketing_visible=true
// with no marketing_label/marketing_blurb (migration 0153's own added
// guard). The store classifies the underlying postgres error; the route
// layer maps it to 400.
//
// Migration 0155, Job 3: this single-admin entry point now rejects any
// call targeting an EXISTING capability (app_private.
// staff_set_capability_registry_entry raises 42501) -- closing the
// bypass where a single platform admin could change min_tier/
// kill_switch/rollout_percentage/limits/capacity_class on a LIVE
// capability without §20.6's two-person approval. Creating a brand-new
// capability is unaffected. See migration 0155's own Job 3 header.
export type CapabilityRegistryAdminErrorReason = 'invalid_input' | 'governance_required';

export class CapabilityRegistryAdminError extends Error {
  readonly reason: CapabilityRegistryAdminErrorReason;
  constructor(reason: CapabilityRegistryAdminErrorReason, message: string) {
    super(message);
    this.name = 'CapabilityRegistryAdminError';
    this.reason = reason;
  }
}

export interface CapabilityRegistryAdminStore {
  // Returns null when the capability does not exist -- the route maps
  // that to 404.
  getEntry(userId: string, capabilityKey: string): Promise<CapabilityRegistryEntry | null>;
  listEntries(userId: string): Promise<CapabilityRegistryEntry[]>;
  // Requires the COMPLETE desired state every call -- the same idiom
  // app_private.staff_upsert_capability_registry_entry (0149) already
  // established for its own six fields; nothing is silently preserved
  // by omission.
  setEntry(userId: string, input: SetCapabilityRegistryEntryInput): Promise<CapabilityRegistryEntry>;
}
