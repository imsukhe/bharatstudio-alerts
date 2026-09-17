// PRF-02 slice 7, §6 catalogue module #11 (Sponsor Card) and the schema
// behind it (packages/db/migrations/0145_v1_prf02_sponsor_card.sql).
//
// THE CARD RENDERS THE SPONSOR AND COUNTS NOTHING (owner decision,
// 2026-09-17, recorded in bharatstudio-requirements/reviews/
// 2026-09-17-remaining-eight-modules-and-youtube-v1-amendment.md Part 1
// §3). There is nowhere in this file for an impression, an exposure, a
// duration, a display counter or a "last shown at" to live: not "we chose
// not to populate it", but "the field does not exist" -- and, one layer
// down, "the column does not exist either". Building one later is a NEW
// decision requiring legal review, not an extension of this one.
//
// ONE ROW PER CHANNEL. An upsert, not a session lifecycle -- unlike the
// Stream Mission or Giveaway/Tournament cards, a sponsor card has no
// start/end to model. `SponsorCardStore.upsert` always writes the single
// row for a channel.
//
// THE LOGO IS AN ASSET, NEVER A URL. §9.1.1 forbids any field on the
// Master Canvas capable of carrying third-party code, a URL, an iframe, a
// script or a stylesheet. `logoStorageKey` is a tenant-scoped
// content-addressed reference (channel id + sha256, §19.1), never a
// fetchable URL of any kind, and there is no url/href/src-shaped field
// anywhere in this file.
//
// LOGO BYTES HAVE NOWHERE TO LIVE YET, AND THAT IS REPORTED RATHER THAN
// WORKED AROUND. No GCS/CDN client, bucket, credential or signed-URL code
// exists anywhere in this repository. Every logo field below is optional
// (nullable), and this slice ships no route that accepts logo bytes --
// the sponsor name, enable toggle and schedule are fully functional
// without one. See the decision record for the exact blocking question.
//
// SCHEDULED PLACEMENT, NOT A SCHEDULE OF ANY OTHER SHAPE. Both schedule
// fields are absolute UTC instants -- "show this sponsor between two
// instants" -- never a recurring daily/local-time window, because that
// would need a creator-timezone concept this repository has not decided
// anywhere.

/** The sponsor-name bound. Identical to public.challenges.title's own
 *  `between 1 and 120` (migration 0109 line 67) and
 *  public.stream_missions.objective's (migration 0135) -- reused, not a
 *  new number chosen here. */
export const SPONSOR_NAME_MIN_LENGTH = 1;
export const SPONSOR_NAME_MAX_LENGTH = 120;

/** No image-mime-type allow-list is decided anywhere in this repository,
 *  and none is invented here -- only a bounded, non-empty string is
 *  required. Reused generically from the same 1-120 text bound above. */
export const SPONSOR_LOGO_MIME_TYPE_MIN_LENGTH = 1;
export const SPONSOR_LOGO_MIME_TYPE_MAX_LENGTH = 120;

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/** Creator/dashboard-facing projection of the channel's one sponsor card. */
export type SponsorCard = {
  schemaVersion: 'v1';
  sponsorCardId: string;
  sponsorName: string;
  /** All three null together, or all three set together -- the logo is
   *  optional and this slice ships no path that populates it (see the
   *  file header). */
  logoContentSha256: string | null;
  logoMimeType: string | null;
  logoByteSize: number | null;
  /** Generated in the database as `channelId + '/' + logoContentSha256`
   *  (§19.1's own target design shape) -- never independently writable,
   *  never a URL. Null exactly when the logo fields are null. */
  logoStorageKey: string | null;
  enabled: boolean;
  /** An instruction about the FUTURE, never a record of the past. Both
   *  null (no schedule -- the card follows `enabled` alone) or both set
   *  (an absolute UTC window). */
  scheduleStartsAt: string | null;
  scheduleEndsAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Overlay/browser-source projection. Three fields, and that is the whole
 * public surface of this module: what the card paints, and nothing about
 * WHETHER, WHEN or HOW OFTEN it was painted. A row is returned only when
 * the card is currently supposed to be visible (enabled, and inside its
 * schedule if it has one) -- every other case is absence, not a flag to
 * interpret.
 */
export type OverlaySponsorCard = {
  schemaVersion: 'v1';
  sponsorName: string;
  logoMimeType: string | null;
  logoStorageKey: string | null;
};

export type UpsertSponsorCardInput = {
  sponsorName: string;
  logoContentSha256: string | null;
  logoMimeType: string | null;
  logoByteSize: number | null;
  enabled: boolean;
  scheduleStartsAt: string | null;
  scheduleEndsAt: string | null;
};

export type UpsertSponsorCardResult =
  | { outcome: 'ok'; sponsorCard: SponsorCard }
  | { outcome: 'forbidden' }
  | { outcome: 'invalid' };

export function isValidSponsorName(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= SPONSOR_NAME_MIN_LENGTH
    && value.length <= SPONSOR_NAME_MAX_LENGTH;
}

export function isValidLogoContentSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX_PATTERN.test(value);
}

export function isValidLogoMimeType(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= SPONSOR_LOGO_MIME_TYPE_MIN_LENGTH
    && value.length <= SPONSOR_LOGO_MIME_TYPE_MAX_LENGTH;
}

/**
 * All three logo fields present together, or all three absent together --
 * the same all-or-nothing rule the database enforces (migration 0145),
 * checked here a second time before the store is ever called.
 */
export function isValidLogoTriple(
  logoContentSha256: unknown,
  logoMimeType: unknown,
  logoByteSize: unknown,
): logoContentSha256 is string | null {
  const allNull = logoContentSha256 === null && logoMimeType === null && logoByteSize === null;
  if (allNull) return true;
  return isValidLogoContentSha256(logoContentSha256)
    && isValidLogoMimeType(logoMimeType)
    && typeof logoByteSize === 'number' && Number.isSafeInteger(logoByteSize) && logoByteSize > 0;
}

/** Both null (no schedule), or both valid, ordered instants. */
export function isValidSchedulePair(startsAt: unknown, endsAt: unknown): boolean {
  if (startsAt === null && endsAt === null) return true;
  if (typeof startsAt !== 'string' || typeof endsAt !== 'string') return false;
  const startMs = Date.parse(startsAt);
  const endMs = Date.parse(endsAt);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return false;
  return endMs > startMs;
}

// Creator/dashboard-facing: authenticated by session, scoped to a channel
// the caller belongs to. Mirrors StreamMissionStore's shape, minus a
// lifecycle -- there is one write method because there is one row.
//
// NEVER TIER-GATED (§12.6). `sponsor_card` is already one of migration
// 0131's twenty catalogue keys; the §30.3 module-count cap already
// governs whether the CANVAS renders the card, and there is no second
// tier gate anywhere in this file.
export interface SponsorCardStore {
  getCurrent(userId: string, channelId: string): Promise<SponsorCard | null>;
  upsert(userId: string, channelId: string, input: UpsertSponsorCardInput): Promise<UpsertSponsorCardResult>;
}

// Overlay/browser-source-facing: authenticated by the overlay session
// bearer token, exactly like StreamMissionOverlayStore.
export interface SponsorCardOverlayStore {
  getForOverlay(token: string, overlayId: string): Promise<OverlaySponsorCard | null>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * The route's outbound narrowing for the overlay projection. A SECOND,
 * independent projection sitting in front of the store's answer: even if
 * a store implementation were changed to hand up an extra field -- a
 * count, an id, a schedule, an "shown" flag -- only the three declared
 * fields survive this function. `additionalProperties` is not merely
 * ignored here; any unexpected key on the input is treated as evidence
 * the answer is untrustworthy and the whole projection is rejected to
 * null rather than partially trusted.
 */
export function projectOverlaySponsorCard(value: unknown): OverlaySponsorCard | null {
  const row = record(value);
  if (!row) return null;
  if (row.schemaVersion !== 'v1') return null;
  if (!isValidSponsorName(row.sponsorName)) return null;

  // Pulled out by NAME, not carried through. An extra key on the input --
  // a count, an id, a schedule, a timestamp -- is simply never read here,
  // which is what keeps a rogue store's extra fields from ever reaching
  // the response, rather than merely being ignored by a schema.
  const logoMimeType = row.logoMimeType;
  const logoStorageKey = row.logoStorageKey;
  if ((logoMimeType === null) !== (logoStorageKey === null)) return null;
  if (logoMimeType !== null && !isValidLogoMimeType(logoMimeType)) return null;
  if (logoStorageKey !== null && (typeof logoStorageKey !== 'string' || logoStorageKey.length === 0 || logoStorageKey.length > 200)) return null;

  return {
    schemaVersion: 'v1',
    sponsorName: row.sponsorName,
    logoMimeType: logoMimeType as string | null,
    logoStorageKey: logoStorageKey as string | null,
  };
}
