import type { Sql } from 'postgres';
import type { PublicCapabilityMatrixEntry, PublicCapabilityMatrixRepository } from '../domain/public-capability-matrix.js';

// CTL-10 (migration 0160). Same MAIN pool posture as
// db/public-channel-repository.ts (createPublicChannelRepository) --
// every /v1/public/* read in this codebase takes the main `sql`, not
// derivedReadSql, per that file's own precedent.
type PublicCapabilityMatrixRow = {
  capability_id: string;
  marketing_label: string | null;
  marketing_blurb: string | null;
  min_tier: string | null;
  is_marketing_section: boolean;
  snapshot_version: number;
  published_at: Date;
};

export function createSqlPublicCapabilityMatrixRepository(sql: Sql): PublicCapabilityMatrixRepository {
  return {
    async getMatrix(): Promise<PublicCapabilityMatrixEntry[]> {
      const rows = await sql<PublicCapabilityMatrixRow[]>`
        select capability_id, marketing_label, marketing_blurb, min_tier, is_marketing_section, snapshot_version, published_at
          from app_private.get_public_capability_matrix()
      `;
      return rows.map((row) => ({
        capabilityId: row.capability_id,
        marketingLabel: row.marketing_label,
        marketingBlurb: row.marketing_blurb,
        minTier: row.min_tier,
        isMarketingSection: row.is_marketing_section,
        snapshotVersion: row.snapshot_version,
        publishedAt: row.published_at.toISOString(),
      }));
    },
  };
}
