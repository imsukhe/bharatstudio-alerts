import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import type { OverlayEvent, OverlaySession, OverlayStore } from '../domain/overlay-store.js';

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fingerprint(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function createSession(webOrigin: string, overlayId: string, expiresAt: Date, token: string): OverlaySession {
  // OBS receives an HTML browser-source page, not the raw SSE response. The
  // page opens the API stream client-side so it can render and animate events.
  // The token is short-lived, scoped and stored only as a hash. The browser
  // keeps it in the URL fragment and sends it to the API only as an
  // Authorization header; it is never placed in an API request URL.
  const origin = webOrigin.replace(/\/+$/, '');
  return { schemaVersion: 'v1', overlayId, expiresAt: expiresAt.toISOString(), streamUrl: `${origin}/overlay/${overlayId}#token=${encodeURIComponent(token)}` };
}

function parseCursor(value: string | undefined): { createdAt: Date | null; deliveryId: string | null } {
  if (!value) return { createdAt: null, deliveryId: null };
  const separator = value.lastIndexOf('|');
  if (separator < 1) throw new Error('invalid_cursor');
  const createdAt = new Date(value.slice(0, separator));
  const deliveryId = value.slice(separator + 1);
  if (Number.isNaN(createdAt.valueOf()) || !UUID.test(deliveryId)) throw new Error('invalid_cursor');
  return { createdAt, deliveryId };
}

export function createSqlOverlayStore(sql: Sql, webOrigin: string): OverlayStore {
  return {
    async create(userId, channelId) {
      const overlayId = randomUUID();
      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
      await sql.begin(async (tx) => {
        await tx`select set_config('app.user_id', ${userId}, true)`;
        await tx`
          insert into overlay_sessions (id, channel_id, token_fingerprint, expires_at, created_at)
          values (${overlayId}::uuid, ${channelId}::uuid, ${fingerprint(token)}, ${expiresAt.toISOString()}::timestamptz, current_timestamp)
        `;
      });
      return createSession(webOrigin, overlayId, expiresAt, token);
    },
    async revoke(userId, overlayId) {
      const rows = await sql.begin(async (tx) => {
        await tx`select set_config('app.user_id', ${userId}, true)`;
        return tx<{ id: string }[]>`
          update overlay_sessions session
             set revoked_at = current_timestamp
           where session.id = ${overlayId}::uuid
             and session.revoked_at is null
             and app_private.can_access_channel(session.channel_id)
           returning session.id
        `;
      });
      return rows.length > 0;
    },
    async rotate(userId, overlayId) {
      const replacementId = randomUUID();
      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
      const rows = await sql.begin(async (tx) => {
        await tx`select set_config('app.user_id', ${userId}, true)`;
        return tx<{ channel_id: string; replacement_id: string }[]>`
          with revoked as (
            update overlay_sessions session
               set revoked_at = current_timestamp
             where session.id = ${overlayId}::uuid
               and session.revoked_at is null
               and app_private.can_access_channel(session.channel_id)
             returning session.channel_id
          ), inserted as (
            insert into overlay_sessions (id, channel_id, token_fingerprint, expires_at, created_at)
            select ${replacementId}::uuid, revoked.channel_id, ${fingerprint(token)}, ${expiresAt.toISOString()}::timestamptz, current_timestamp
              from revoked
            returning channel_id, id as replacement_id
          )
          select channel_id, replacement_id from inserted
        `;
      });
      const channelId = rows[0]?.channel_id;
      if (!channelId) return null;
      return createSession(webOrigin, replacementId, expiresAt, token);
    },
    async replay(token, overlayId, lastEventId, limit) {
      const cursor = parseCursor(lastEventId);
      return sql.begin(async (tx) => {
        await tx`select set_config('app.overlay_session_id', ${overlayId}, true)`;
        const active = await tx<{ overlay_id: string }[]>`
          select overlay_id from app_private.lookup_overlay_token(${overlayId}::uuid, ${fingerprint(token)})
        `;
        if (!active[0]) return null;
        const rows = await tx<{
          cursor: string; event_id: string; event_type: OverlayEvent['eventType']; trace_id: string; created_at: Date; payload: Record<string, unknown>;
        }[]>`
          select cursor, event_id, event_type, trace_id, created_at, payload
            from app_private.get_overlay_events(${overlayId}::uuid, ${cursor.createdAt}, ${cursor.deliveryId}::uuid, ${limit})
        `;
        return rows.map((row): OverlayEvent => ({ schemaVersion: 'v1', cursor: row.cursor, eventId: row.event_id, eventType: row.event_type, traceId: row.trace_id, createdAt: row.created_at.toISOString(), payload: row.payload }));
      }) as Promise<OverlayEvent[] | null>;
    },
    async acknowledge(token, overlayId, cursor, eventId) {
      parseCursor(cursor);
      return sql.begin(async (tx) => {
        await tx`select set_config('app.overlay_session_id', ${overlayId}, true)`;
        const active = await tx<{ overlay_id: string }[]>`
          select overlay_id from app_private.lookup_overlay_token(${overlayId}::uuid, ${fingerprint(token)})
        `;
        if (!active[0]) return false;
        const rows = await tx<{ acknowledged: boolean }[]>`
          select app_private.ack_overlay_cursor(${overlayId}::uuid, ${cursor}, ${eventId}::uuid) as acknowledged
        `;
        return rows[0]?.acknowledged === true;
      }) as Promise<boolean>;
    },
  };
}
