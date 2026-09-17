import type { FastifyInstance } from 'fastify';
import { requirePlatformAdmin } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import { CapabilityRegistryAdminError, type CapabilityKind, type CapabilityRegistryAdminStore } from '../domain/capability-registry-admin.js';
import { logSafeError } from '../observability/safe-log.js';

// CTL registry spec alignment (migration 0153). Platform-staff-only
// surface over the §20.2 fields migration 0149 did not ship -- kind,
// limits, beta, marketing_visible, marketing_label, marketing_blurb.
// Deliberately its OWN file and its OWN endpoints, not folded into
// routes/capability-change-management.ts: this is a single-admin,
// immediate write (mirroring app_private.staff_kill_capability_now /
// staff_revert_capability_registry_entry's own posture), not a
// two-staff-approved staged change -- see migration 0153's own header
// and domain/capability-registry-admin.ts for exactly why the six new
// fields are not routed through 0152's propose/approve/apply workflow.
// Same requirePlatformAdmin gate as routes/capability-change-management.ts
// and routes/admin.ts.

const capabilityKeyParams = {
  type: 'object', additionalProperties: false, required: ['capabilityKey'],
  properties: { capabilityKey: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,99}$' } },
} as const;

const capacityClasses = [
  'active_connector', 'active_widget', 'ai_usage', 'media_upload',
  'custom_asset', 'team_seat', 'automation_volume', 'master_canvas_module',
] as const;
const tiers = ['free', 'pro', 'creator', 'studio'] as const;
// §20.2's own enum, verbatim -- does NOT contain marketing_section, which
// CTL-12 needs. See migration 0153's header for why that gap is reported
// rather than closed here.
const kinds: CapabilityKind[] = ['widget', 'module', 'feature', 'hub_lane', 'lobby_mode', 'ai_feature'];

function unavailable(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string) {
  return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'capability_registry_admin_unavailable', message: 'Capability registry administration is temporarily unavailable', traceId, retryable: true });
}

export async function registerCapabilityRegistryAdminRoutes(
  app: FastifyInstance,
  sessions?: SessionStore,
  store?: CapabilityRegistryAdminStore,
  adminGate?: { isPlatformAdmin(userId: string): Promise<boolean> },
): Promise<void> {
  const adminAuth = requirePlatformAdmin(sessions, adminGate);

  app.get('/v1/admin/capability-registry/entries', {
    preHandler: adminAuth,
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    const entries = await store.listEntries(request.auth.userId);
    return reply.code(200).send({ schemaVersion: 'v1', entries });
  });

  app.get<{ Params: { capabilityKey: string } }>('/v1/admin/capability-registry/entries/:capabilityKey', {
    preHandler: adminAuth,
    schema: { params: capabilityKeyParams },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    const entry = await store.getEntry(request.auth.userId, request.params.capabilityKey);
    if (!entry) {
      return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'capability_not_found', message: 'Capability not found', traceId: request.id });
    }
    return reply.code(200).send(entry);
  });

  // Requires the COMPLETE desired state every call -- the same idiom
  // app_private.staff_upsert_capability_registry_entry (0149) already
  // established; nothing is silently preserved by omission. Immediate,
  // single-admin, still versioned and audited via the registry's own
  // table-level triggers (migration 0153's own header).
  app.put<{ Params: { capabilityKey: string }; Body: {
    capacityClass: typeof capacityClasses[number]; description: string; killSwitch: boolean;
    rolloutPercentage: number; minTier: typeof tiers[number] | null; kind: CapabilityKind | null;
    limits: Record<string, unknown>; beta: boolean; marketingVisible: boolean;
    marketingLabel: string | null; marketingBlurb: string | null;
  } }>('/v1/admin/capability-registry/entries/:capabilityKey', {
    preHandler: adminAuth,
    schema: {
      params: capabilityKeyParams,
      body: {
        type: 'object', additionalProperties: false,
        required: ['capacityClass', 'description', 'killSwitch', 'rolloutPercentage', 'minTier', 'kind', 'limits', 'beta', 'marketingVisible', 'marketingLabel', 'marketingBlurb'],
        properties: {
          capacityClass: { type: 'string', enum: [...capacityClasses] },
          description: { type: 'string', minLength: 1, maxLength: 500 },
          killSwitch: { type: 'boolean' },
          rolloutPercentage: { type: 'integer', minimum: 0, maximum: 100 },
          minTier: { type: ['string', 'null'], enum: [...tiers, null] },
          kind: { type: ['string', 'null'], enum: [...kinds, null] },
          limits: { type: 'object' },
          beta: { type: 'boolean' },
          marketingVisible: { type: 'boolean' },
          marketingLabel: { type: ['string', 'null'], maxLength: 200 },
          marketingBlurb: { type: ['string', 'null'], maxLength: 500 },
        },
      },
    },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const entry = await store.setEntry(request.auth.userId, {
        capabilityKey: request.params.capabilityKey,
        capacityClass: request.body.capacityClass,
        description: request.body.description,
        killSwitch: request.body.killSwitch,
        rolloutPercentage: request.body.rolloutPercentage,
        minTier: request.body.minTier,
        kind: request.body.kind,
        limits: request.body.limits,
        beta: request.body.beta,
        marketingVisible: request.body.marketingVisible,
        marketingLabel: request.body.marketingLabel,
        marketingBlurb: request.body.marketingBlurb,
      });
      return reply.code(200).send(entry);
    } catch (error) {
      if (error instanceof CapabilityRegistryAdminError) {
        // Migration 0155, Job 3: 'governance_required' means the request
        // conflicts with the capability's current (already-existing)
        // state -- the correct path is the two-person workflow, not a
        // malformed request -- so it maps to 409, not 400.
        const status = error.reason === 'governance_required' ? 409 : 400;
        return reply.code(status).send({ schemaVersion: 'v1', errorCode: error.reason, message: error.message, traceId: request.id, retryable: false });
      }
      logSafeError(request, 'capability_registry_set_failed', error);
      return unavailable(reply, request.id);
    }
  });
}
