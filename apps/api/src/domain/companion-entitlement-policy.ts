// L24 Companion separation (migration 0100, master plan 3.7): Companion's
// entitlement source, independent of the Alerts tier.
//
// New, additive interface -- deliberately NOT a change to
// apps/api/src/domain/alert-store.ts (unowned by this task; see this
// task's file-ownership boundary). `buildApp` and the production entrypoint
// now provide the SQL-backed dependency. It remains optional only for focused
// callers, which retain the legacy fallback constants for isolated tests.

export type CompanionActionGroup = 'alerts' | 'obs' | 'mirror' | 'stream';

// Mirrors migration 0100's app_private.companion_grant_policy(uuid)
// return row 1:1 (source_key, granted, action_limit, action_groups).
export type CompanionGrantPolicy = {
  schemaVersion: 'v1';
  channelId: string;
  sourceKey: string; // 'alerts:free' | 'alerts:pro' | 'alerts:creator' | 'alerts:studio' | 'standalone'
  granted: boolean;
  actionLimit: number;
  actionGroups: CompanionActionGroup[];
};

export interface CompanionEntitlementStore {
  // Resolves the live Alerts-plan -> Companion-grant mapping for a
  // channel: null when the caller cannot access the channel (mirrors the
  // can_access_channel guard on migration 0100's underlying function, and
  // the null-on-no-access convention AlertStore.getEntitlements already
  // uses). Callers that also hold a per-channel
  // channel_entitlement_versions.values.companionActionGroups override
  // must still prefer that override (migration 0089's precedence rule,
  // preserved verbatim by 0100) -- this store only ever returns the live
  // policy DEFAULT, the same value migration 0100's DB functions fall
  // back to when no override is present.
  getCompanionGrantPolicy(userId: string, channelId: string): Promise<CompanionGrantPolicy | null>;
}
