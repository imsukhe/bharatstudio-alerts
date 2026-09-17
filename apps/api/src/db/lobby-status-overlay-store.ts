import { createHash } from 'node:crypto';
import type { LobbyStatusOverlayStore, OverlayLobbyStatus } from '../domain/lobby-status-store.js';
import type { Sql } from 'postgres';

// PRF-02 slice 6, §6 catalogue module #16 (Lobby Status) -- the overlay
// read half.
//
// Mirrors apps/api/src/db/moderator-status-overlay-store.ts,
// reaction-cloud-overlay-store.ts and stream-mission-overlay-store.ts
// exactly: sha256 fingerprint of the bearer token, matched against
// overlay_sessions.token_fingerprint INSIDE the security-definer function
// (packages/db/migrations/0140). Same overlay_sessions table, same gate --
// no second auth mechanism, and no scoping decision made in TypeScript.
//
// RT-12: this file's name contains "overlay", so the required-queries
// scan's rule 2 covers every app_private call in it regardless of the
// function's name; the factory below is constructed with `derivedReadSql`
// in apps/api/src/index.ts, so rule 3 covers it structurally as well; and
// the function follows the list_overlay_* convention, so rule 1 covers it
// too. All three independently require the manifest entry in
// packages/db/explain-plans/required-queries.json.
//
// ======================================================================
// THREE NUMBERS. THAT IS THE WHOLE SURFACE.
// ======================================================================
// §16: the public overlay shows "aggregate status only ... Never player
// identifiers, never Discord names, never codes or passwords", and the
// owner's 2026-09-16 decision 4 requires that to be a property of the read
// rather than of the renderer. app_private.list_overlay_lobby_status
// returns exactly (seat_count, confirmed_seat_count, queue_count), so this
// file selects three columns because three columns are all there are.
//
// Widening this select is not possible without widening 0140's own
// `returns table` signature, which
// packages/db/tests/prf02_slice6_lobby_status.sql asserts against directly
// -- twice, from pg_get_function_result and from a table materialised out
// of a live call.
//
// THE LOBBY ID IS NOT READ HERE, and not because it was forgotten: it
// carries no information the card paints, and "a session id" is on the
// prohibited list. There is no per-viewer row anywhere in this schema for
// it to be joined to either, so nothing on this path can correlate one
// visit to another.
//
// ======================================================================
// THE ENTITLEMENT IS NOT CHECKED IN THIS FILE, DELIBERATELY.
// ======================================================================
// §30.3 places the Lobby Engine at Creator+, and the owner's decision 5
// makes that `tier in ('creator','studio')` OR an active Events Pack grant
// (a check with no grant path yet, so today's behaviour is exactly
// "included at Creator+"). That check lives INSIDE
// app_private.list_overlay_lobby_status, as
// app_private.events_pack_entitled -- one place, in SQL, alongside the
// session gate. An unentitled channel's perfectly valid overlay token
// simply matches no row, so this file receives `undefined` and the module
// renders nothing.
//
// Putting a second copy of the tier rule in TypeScript would create two
// places for it to be wrong, and the one in SQL is the one the SQL test
// can prove.
function fingerprint(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function createSqlLobbyStatusOverlayStore(sql: Sql): LobbyStatusOverlayStore {
  return {
    async getForOverlay(token, overlayId): Promise<OverlayLobbyStatus | null> {
      const rows = await sql<{ seat_count: string | number; confirmed_seat_count: string | number; queue_count: string | number }[]>`
        select seat_count, confirmed_seat_count, queue_count
          from app_private.list_overlay_lobby_status(${overlayId}::uuid, ${fingerprint(token)})
      `;
      const row = rows[0];
      // Zero rows is the answer for an unrecognised, expired, revoked or
      // foreign token, for a channel with no open lobby, AND for an
      // unentitled channel. All four mean the same thing to the card --
      // paint nothing -- so they are collapsed to null here rather than
      // given four shapes the renderer would have to tell apart.
      if (!row) return null;
      const seatCount = Number(row.seat_count);
      const confirmedSeatCount = Number(row.confirmed_seat_count);
      const queueCount = Number(row.queue_count);
      if (!Number.isSafeInteger(seatCount) || !Number.isSafeInteger(confirmedSeatCount) || !Number.isSafeInteger(queueCount)) {
        return null;
      }
      return { schemaVersion: 'v1', seatCount, confirmedSeatCount, queueCount };
    },
  };
}
