import type { FastifyInstance } from 'fastify';
import type { PublicCapabilityMatrixRepository } from '../domain/public-capability-matrix.js';

// CTL-10 (migration 0160): GET /v1/public/capability-matrix -- §20.4.
// The one capability surface with NO token at all. Deliberately its own
// file, not folded into routes/public.ts: this is the public read half
// of the capability control plane, own dedicated store
// (PublicCapabilityMatrixRepository), same posture routes/
// capability-registry-admin.ts already took for the STAFF half of the
// same plane. No auth pre-handler anywhere in this file -- that
// omission IS the contract, matching every other /v1/public/* route in
// routes/public.ts (no requirePlatformAdmin, no requireSession).
//
// The response shape is exactly PublicCapabilityMatrixRepository's
// declared type (domain/public-capability-matrix.ts) -- capabilityId/
// marketingLabel/marketingBlurb/minTier/isMarketingSection/
// snapshotVersion/publishedAt per entry, nothing else. There is no
// server-side filtering to write here because there is nothing left to
// filter: app_private.get_public_capability_matrix (migration 0160)
// already excludes every non-marketing_visible and killed row, and its
// own OUT signature makes capacityClass/limits/rollout/killSwitch/beta
// unreachable from this store at all -- see that function's own header.
export async function registerPublicCapabilityMatrixRoutes(
  app: FastifyInstance,
  store?: PublicCapabilityMatrixRepository,
): Promise<void> {
  app.get('/v1/public/capability-matrix', async (request, reply) => {
    if (!store) {
      return reply.code(503).send({
        schemaVersion: 'v1',
        errorCode: 'public_capability_matrix_unavailable',
        message: 'The public capability matrix is temporarily unavailable',
        traceId: request.id,
        retryable: true,
      });
    }

    const entries = await store.getMatrix();
    return reply.code(200).send({
      schemaVersion: 'v1',
      entries: entries.map((entry) => ({
        capabilityId: entry.capabilityId,
        marketingLabel: entry.marketingLabel,
        marketingBlurb: entry.marketingBlurb,
        minTier: entry.minTier,
        isMarketingSection: entry.isMarketingSection,
        snapshotVersion: entry.snapshotVersion,
        publishedAt: entry.publishedAt,
      })),
    });
  });
}
