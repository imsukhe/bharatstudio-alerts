import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import type { DisplayStyle, OverlayBrandingStore } from '../domain/branding.js';

function fingerprint(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function createSqlOverlayBrandingStore(sql: Sql): OverlayBrandingStore {
  return {
    async listForOverlay(token, overlayId) {
      const rows = await sql<{ display_style: DisplayStyle; artifact_id: string }[]>`
        select display_style, artifact_id
          from app_private.list_overlay_lottie_assets(${overlayId}::uuid, ${fingerprint(token)})
      `;
      return rows.map((row) => ({ displayStyle: row.display_style, artifactId: row.artifact_id }));
    },
    async getForOverlay(token, overlayId, artifactId) {
      const rows = await sql<{ lottie_bytes: Buffer; mime_type: string }[]>`
        select lottie_bytes, mime_type
          from app_private.get_overlay_lottie_asset(${overlayId}::uuid, ${fingerprint(token)}, ${artifactId}::uuid)
      `;
      const row = rows[0];
      return row ? { bytes: row.lottie_bytes, mimeType: row.mime_type } : null;
    },
  };
}
