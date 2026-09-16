/*
 * Pure, DOM-free helpers for the Reaction Cloud module (§6 catalogue
 * module #5) — same pattern as ./moderator-status-logic.ts and
 * ./tug-of-war-vote-logic.ts: testable directly, no browser or
 * useParams context needed.
 *
 * WHAT THIS CLOUD IS, AND THE THREE THINGS IT IS NOT.
 *
 * It is a server-side sampled, aggregated view of the reactions viewers
 * sent to this channel inside the read's one-minute window — one glyph
 * per curated-catalogue entry, sized by how many reactions that entry
 * received. A reaction is a send of an entry that ALREADY EXISTS in the
 * curated sticker catalogue (owner decision, 2026-09-16), which is why
 * nothing in this file knows about assets, uploads or moderation state.
 *
 *   1. It is NOT a stream of events. The snapshot this file guards is
 *      already `count(*)` grouped by entry, capped by a configured
 *      display ceiling, both applied inside
 *      `app_private.list_overlay_reaction_cloud` (migration 0139). There
 *      is deliberately no cap, slice or sampling of any kind in this
 *      file: §19.5 requires the client never to receive the full stream
 *      and then drop some, and the absence of a cap here is what makes
 *      "it happens server-side" checkable rather than merely claimed.
 *
 *   2. It is NOT identifying. §6 #5 requires it, and the owner's decision
 *      requires that to be a property of the QUERY: the read returns
 *      catalogue entry ids, their already-public display names and
 *      counts — no viewer id, no anonymous identity token, no session id,
 *      no IP and no timestamp of any precision. `isReactionCloudEntry`
 *      below is a third line, not the guarantee: it rejects any payload
 *      carrying a key it does not expect, so a server that somehow began
 *      returning a viewer identifier would render NOTHING rather than
 *      render it.
 *
 *   3. It is NOT a rate limiter. Rate limiting is the creator's own
 *      per-channel `rateLimitPerMinute`, enforced in SQL against a
 *      one-minute window on the SEND path. Nothing on the render path
 *      limits anything, and nothing here should start to.
 */

export const REACTION_ENTRY_SOURCES = ['catalogue', 'creator_pack'] as const;
export type ReactionEntrySource = (typeof REACTION_ENTRY_SOURCES)[number];

export type ReactionCloudEntry = {
  entrySource: ReactionEntrySource;
  entryId: string;
  displayName: string;
  reactionCount: number;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function exactKeys(row: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(row).length === keys.length && keys.every((key) => Object.hasOwn(row, key));
}

/**
 * Exactly the four declared keys, a known entry source, non-empty id and
 * name, and a count that is a positive safe integer.
 *
 * `exactKeys` is doing real work here rather than being defensive
 * boilerplate: it is what makes an unexpected extra field — a viewerId,
 * an anonymousIdentityId, a sessionId, an ipAddress, a createdAt — fail
 * the guard outright instead of being silently ignored and then, one
 * careless refactor later, rendered.
 */
export function isReactionCloudEntry(value: unknown): value is ReactionCloudEntry {
  const row = record(value);
  if (!row || !exactKeys(row, ['entrySource', 'entryId', 'displayName', 'reactionCount'])) return false;
  if (row.entrySource !== 'catalogue' && row.entrySource !== 'creator_pack') return false;
  if (typeof row.entryId !== 'string' || row.entryId.length === 0) return false;
  if (typeof row.displayName !== 'string' || row.displayName.length === 0) return false;
  const count = row.reactionCount;
  return typeof count === 'number' && Number.isSafeInteger(count) && count > 0;
}

/**
 * The whole payload, or nothing. A single malformed entry invalidates the
 * snapshot rather than being dropped quietly: on a broadcast surface, a
 * cloud that is quietly missing a glyph is indistinguishable from a
 * correct one, so there would be no way to notice the server had started
 * returning something unexpected.
 */
export function isReactionCloud(value: unknown): value is ReactionCloudEntry[] {
  return Array.isArray(value) && value.every(isReactionCloudEntry);
}

/** True when the cloud has something to paint. */
export function hasReactions(entries: ReactionCloudEntry[] | null): boolean {
  return entries !== null && entries.length > 0;
}

export type ReactionGlyphPlacement = {
  entryId: string;
  label: string;
  /**
   * Horizontal drift from the glyph's own flow position, as a percentage
   * of the GLYPH's own box — which is exactly what a CSS percentage in
   * `transform: translate()` means. The glyph's base position comes from
   * ordinary flex-wrap flow declared once in CSS, never from a per-frame
   * `left`/`top` write.
   */
  offsetXPercent: number;
  /** Vertical drift, same units and same reason. */
  offsetYPercent: number;
  /** Relative size, 1 for the busiest entry in the cloud. */
  scale: number;
};

// Presentational constants, not policy limits. They describe how a glyph
// LOOKS, the same way moderator-status-module.ts's `translateY(-4px)` and
// `240ms ease` do; none of them caps, filters, samples or refuses
// anything, and none stands in for a number an authority would have to
// decide. The one number that IS a limit on this surface — how many
// entries may be shown — is the configured display ceiling, and it lives
// server-side in the SQL LIMIT, not here.
const SMALLEST_GLYPH_SCALE = 0.6;
const LARGEST_GLYPH_SCALE = 1;
const GLYPH_DRIFT_PERCENT = 22;
// The golden angle. Successive indices land far apart on the ring, so a
// cloud of any size spreads instead of clustering — a property of the
// constant, not a tuning choice.
const GOLDEN_ANGLE_RADIANS = Math.PI * (3 - Math.sqrt(5));

/**
 * Deterministic placement. Given the same entries in the same order, this
 * returns the same drift and scale every time — there is no randomness and
 * no dependence on wall-clock time, so a cloud at a fixed underlying state
 * does not shimmer between frames. (The server's own ordering is
 * deterministic for the same reason: `count desc, display_name, entry_id`.)
 *
 * The base layout is ordinary centred flex-wrap flow, declared once in the
 * host page's CSS; this function only produces the per-glyph DRIFT and
 * SCALE that turn a row of labels into a cloud, and both are applied
 * through `transform` alone (PRF-03). Nothing here reads or writes a
 * layout property, so there is no way for this module to trigger layout
 * from the shared frame loop.
 *
 * Sunflower/phyllotaxis drift: index i sits at angle i·φ and radius
 * proportional to √(i/n), which spreads points evenly over a disc rather
 * than bunching them at the centre.
 */
export function layoutReactionCloud(entries: readonly ReactionCloudEntry[]): ReactionGlyphPlacement[] {
  if (entries.length === 0) return [];
  let busiest = 0;
  for (const entry of entries) if (entry.reactionCount > busiest) busiest = entry.reactionCount;
  if (busiest <= 0) return [];

  return entries.map((entry, index) => {
    const share = entry.reactionCount / busiest;
    const scale = SMALLEST_GLYPH_SCALE + (LARGEST_GLYPH_SCALE - SMALLEST_GLYPH_SCALE) * share;
    // A single glyph sits exactly where flow put it rather than at radius
    // zero of a one-point ring — the same result, stated plainly.
    const radius = entries.length === 1 ? 0 : GLYPH_DRIFT_PERCENT * Math.sqrt(index / (entries.length - 1));
    const angle = index * GOLDEN_ANGLE_RADIANS;
    return {
      entryId: entry.entryId,
      label: formatReactionLabel(entry),
      offsetXPercent: radius * Math.cos(angle),
      offsetYPercent: radius * Math.sin(angle),
      scale,
    };
  });
}

/**
 * The rendered label: the catalogue entry's own display name and the
 * count. The name is the STICKER's name, not a person's — it is the same
 * field the unauthenticated tip-page sticker list already shows any
 * viewer — and there is deliberately no branch here that could render a
 * supporter name, a message or an amount, because no such field reaches
 * this file.
 */
export function formatReactionLabel(entry: ReactionCloudEntry): string {
  return `${entry.displayName} ×${entry.reactionCount}`;
}
