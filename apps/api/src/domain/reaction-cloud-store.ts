// PRF-02 slice 6, §6 catalogue module #5 (Reaction Cloud), and PRF-06's
// reactions half.
//
// WHAT A REACTION IS, AND WHY THERE IS NO REACTION CATALOGUE TYPE HERE.
// A reaction is a SEND of an entry from the curated sticker catalogue that
// already exists -- first-party entries (`sticker_catalogue_entries`,
// migration 0110) plus staff-reviewed creator packs
// (`creator_sticker_packs`, migration 0119). That is the owner's decision
// of 2026-09-16, and it is why this file declares no asset, no upload
// shape, no mime type and no moderation state: a viewer can only ever
// send something that was already approved, so the moderation question is
// already answered somewhere else and must not be re-opened here.
//
// THE SHAPE IS NON-IDENTIFYING BECAUSE THE QUERY IS. §6 #5 requires the
// Reaction Cloud to be non-identifying, and the owner's decision requires
// that to be a property of the read rather than of the renderer.
// `app_private.list_overlay_reaction_cloud` (migration 0139) returns
// exactly four columns -- entry_source, entry_id, display_name,
// reaction_count -- so this type has exactly four fields. There is nowhere
// in this shape for a viewer id, an anonymous identity token, a session
// id, an IP or a timestamp to live: not "we chose not to populate it", but
// "the field does not exist".
//
// `displayName` is catalogue metadata the PUBLIC tip-page read already
// returns to any viewer (`list_public_stickers_for_channel` /
// `list_public_creator_pack_for_channel`, both `(id, display_name,
// category)`). It is a sticker's name, not a person's.

/** Which half of the curated catalogue an entry came from. */
export const REACTION_ENTRY_SOURCES = ['catalogue', 'creator_pack'] as const;
export type ReactionEntrySource = (typeof REACTION_ENTRY_SOURCES)[number];

export type ReactionCloudEntry = {
  entrySource: ReactionEntrySource;
  entryId: string;
  displayName: string;
  reactionCount: number;
};

/**
 * Overlay-facing: authenticated by the bearer overlay-session token, not a
 * session cookie. Mirrors every other overlay store's convention (token
 * first, overlayId second).
 *
 * The returned array is ALREADY the server-side sample (§19.5): the SQL
 * function aggregates every event into one row per entry and then applies
 * the configured display ceiling inside the database. Nothing downstream
 * of this interface is permitted to receive the full stream and drop some
 * of it, and nothing downstream is given the chance to -- the stream is
 * never on the wire.
 */
export interface ReactionCloudOverlayStore {
  listForOverlay(token: string, overlayId: string): Promise<ReactionCloudEntry[]>;
}

/**
 * The outcomes a send can have.
 *
 * `rate_limited` is an ordinary, expected answer on a high-frequency path
 * rather than an error: this SENDER reached 60 sends inside the current
 * one-minute window (owner direction, 2026-09-17 -- migration 0141).
 *
 * `sender_unidentified` means the fingerprint could not be resolved to a
 * sender at all. It is a REFUSAL, never a silent accept and never a
 * fallback to the ambient per-IP limit: a fallback would make dropping a
 * cookie the cheapest route to the weaker limit, so the fallback would be
 * the attack.
 */
export type ReactionSendOutcome =
  | 'recorded'
  | 'rate_limited'
  | 'sender_unidentified'
  | 'unknown_entry'
  | 'not_available';

/**
 * The public, unauthenticated send path.
 *
 * THE FOURTH ARGUMENT IS A FINGERPRINT, NOT AN IDENTITY. It is the SHA-256
 * hex hash of the existing `__Host-bsa-anonymous` browser token -- the same
 * value the two public checkout POSTs already compute with the same helper
 * in `apps/api/src/routes/public.ts`, and the raw token never reaches the
 * database. It is used for ADMISSION CONTROL ONLY: `record` returns an
 * outcome and nothing derived from the sender, the value is never written
 * to the reaction row, never returned by any read, never logged and never
 * used as a metric label.
 *
 * The rate limit it keys is 60 sends per minute PER SENDER. The previous
 * per-CHANNEL cap was removed on 2026-09-17 because it throttled the
 * creator: a popular stream exhausted the channel budget and then refused
 * legitimate viewers.
 */
export interface ReactionSendStore {
  record(
    channelId: string,
    entrySource: ReactionEntrySource,
    entryId: string,
    senderTokenHash: string,
  ): Promise<ReactionSendOutcome>;
}

function isEntrySource(value: unknown): value is ReactionEntrySource {
  return value === 'catalogue' || value === 'creator_pack';
}

/**
 * The route's outbound narrowing. This is a SECOND, independent projection
 * sitting in front of the store's answer, not a pass-through that trusts
 * it: even if a store implementation were changed to hand up extra fields,
 * only the four declared ones survive this function, and an entry that
 * fails any check is dropped rather than rendered.
 *
 * A count that is not a positive safe integer is treated as no entry at
 * all. A zero, negative or fractional count on a broadcast overlay is
 * worse than an absent glyph.
 *
 * This function does NOT re-apply the display ceiling, and that is
 * deliberate rather than an omission: re-capping here would make the
 * client-side/server-side question ambiguous, and §19.5 wants exactly one
 * answer to it. The ceiling is applied once, inside
 * `app_private.list_overlay_reaction_cloud`, before the rows ever leave
 * the database.
 */
export function projectReactionCloud(entries: readonly ReactionCloudEntry[] | null | undefined): ReactionCloudEntry[] {
  if (!Array.isArray(entries)) return [];
  const projected: ReactionCloudEntry[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    if (!isEntrySource(entry.entrySource)) continue;
    if (typeof entry.entryId !== 'string' || entry.entryId.length === 0) continue;
    if (typeof entry.displayName !== 'string' || entry.displayName.length === 0) continue;
    const count = entry.reactionCount;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count <= 0) continue;
    projected.push({
      entrySource: entry.entrySource,
      entryId: entry.entryId,
      displayName: entry.displayName,
      reactionCount: count,
    });
  }
  return projected;
}
