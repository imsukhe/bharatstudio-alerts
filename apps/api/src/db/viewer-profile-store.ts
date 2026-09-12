import { createHash, randomInt, randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import type {
  ClaimOutcome,
  ClaimResult,
  PublicProfileSummary,
  ReceiptMintResult,
  ResolvedReceipt,
  ViewerChannelBadges,
  ViewerProfileStore,
} from '../domain/viewer-profile-store.js';

// RECEIPT TOKEN DESIGN — mirrors 0097's TipIntent discipline (see
// apps/api/src/db/tipintent-store.ts): Crockford Base32, no raw token ever
// stored (only sha256), token carries no payload. Longer than TipIntent's
// 10 chars (16 => 80 bits) because a receipt has NO expiry — it is a
// permanent link to a real payment, so its whole-lifetime guessing
// resistance has to hold up over years, not 30 minutes.
const RECEIPT_TOKEN_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RECEIPT_TOKEN_LENGTH = 16;

function generateReceiptToken(): string {
  let token = '';
  for (let i = 0; i < RECEIPT_TOKEN_LENGTH; i++) {
    token += RECEIPT_TOKEN_ALPHABET[randomInt(0, RECEIPT_TOKEN_ALPHABET.length)];
  }
  return token;
}

function hashReceiptToken(token: string): string {
  return createHash('sha256').update(token.toUpperCase()).digest('hex');
}

async function inViewerTransaction<T>(sql: Sql, viewerAccountId: string, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`select set_config('app.viewer_id', ${viewerAccountId}, true)`;
    return callback(tx);
  });
  return result as T;
}

type ReceiptRow = {
  channel_handle: string;
  channel_display_name: string;
  gross_amount_paise: string;
  refunded_amount_paise: string;
  net_amount_paise: string;
  currency: 'INR';
  donor_display_name: string | null;
  message: string | null;
  payment_status: string;
  paid_at: Date;
};

type BadgeRow = {
  net_tip_count: string;
  net_lifetime_paise: string;
  first_supported_at: Date | null;
  current_streak_days: number;
  badges: string[] | null;
};

export function createSqlViewerProfileStore(sql: Sql): ViewerProfileStore {
  return {
    async mintReceipt(intentId): Promise<ReceiptMintResult> {
      const paymentRows = await sql<{ find_payment_id_for_intent: string | null }[]>`
        select app_private.find_payment_id_for_intent(${intentId}::uuid)
      `;
      const paymentId = paymentRows[0]?.find_payment_id_for_intent;
      if (!paymentId) return { minted: false };
      const token = generateReceiptToken();
      const rows = await sql<{ id: string }[]>`
        select id from app_private.create_payment_receipt(${randomUUID()}::uuid, ${paymentId}::uuid, ${hashReceiptToken(token)})
      `;
      if (!rows[0]) return { minted: false };
      return { minted: true, token };
    },

    async resolveReceipt(token): Promise<ResolvedReceipt | null> {
      const rows = await sql<ReceiptRow[]>`
        select channel_handle, channel_display_name, gross_amount_paise, refunded_amount_paise,
               net_amount_paise, currency, donor_display_name, message, payment_status, paid_at
          from app_private.get_payment_receipt_by_token_hash(${hashReceiptToken(token)})
      `;
      const row = rows[0];
      if (!row) return null;
      return {
        channelHandle: row.channel_handle,
        channelDisplayName: row.channel_display_name,
        grossAmountPaise: row.gross_amount_paise,
        refundedAmountPaise: row.refunded_amount_paise,
        netAmountPaise: row.net_amount_paise,
        currency: row.currency,
        donorDisplayName: row.donor_display_name,
        message: row.message,
        paymentStatus: row.payment_status,
        paidAt: row.paid_at.toISOString(),
      };
    },

    async claimPlatformIdentity(viewerAccountId, provider, providerUserId, displayName): Promise<ClaimOutcome> {
      return inViewerTransaction(sql, viewerAccountId, async (tx) => {
        const rows = await tx<{ viewer_identity_id: string; claim_result: ClaimResult }[]>`
          select viewer_identity_id, claim_result
            from app_private.claim_platform_identity(${viewerAccountId}::uuid, ${provider}, ${providerUserId}, ${displayName ?? null})
        `;
        const row = rows[0];
        if (!row) throw new Error('claim_platform_identity returned no row');
        return { viewerIdentityId: row.viewer_identity_id, result: row.claim_result };
      });
    },

    async getChannelBadges(viewerAccountId, channelId): Promise<ViewerChannelBadges> {
      return inViewerTransaction(sql, viewerAccountId, async (tx) => {
        const rows = await tx<BadgeRow[]>`
          select net_tip_count, net_lifetime_paise, first_supported_at, current_streak_days, badges
            from app_private.get_viewer_channel_badges(${viewerAccountId}::uuid, ${channelId}::uuid)
        `;
        const row = rows[0];
        return {
          netTipCount: row?.net_tip_count ?? '0',
          netLifetimeAmountPaise: row?.net_lifetime_paise ?? '0',
          firstSupportedAt: row?.first_supported_at ? row.first_supported_at.toISOString() : null,
          currentStreakDays: row?.current_streak_days ?? 0,
          badges: row?.badges ?? [],
        };
      });
    },

    async searchPublicProfiles(query): Promise<PublicProfileSummary[]> {
      const rows = await sql<{ display_name: string | null; profile_slug: string }[]>`
        select display_name, profile_slug from app_private.search_public_viewer_profiles(${query})
      `;
      return rows.map((row) => ({ displayName: row.display_name, profileSlug: row.profile_slug }));
    },

    async getPublicProfile(slug): Promise<PublicProfileSummary | null> {
      const rows = await sql<{ display_name: string | null; profile_slug: string }[]>`
        select display_name, profile_slug from app_private.get_public_viewer_profile(${slug})
      `;
      const row = rows[0];
      return row ? { displayName: row.display_name, profileSlug: row.profile_slug } : null;
    },

    async setProfileVisibility(viewerAccountId, visibility, slug) {
      return inViewerTransaction(sql, viewerAccountId, async (tx) => {
        const rows = await tx<{ profile_visibility: 'private' | 'public'; profile_slug: string | null }[]>`
          select profile_visibility, profile_slug from app_private.set_viewer_profile_visibility(${viewerAccountId}::uuid, ${visibility}, ${slug})
        `;
        const row = rows[0];
        if (!row) throw new Error('set_viewer_profile_visibility returned no row');
        return { visibility: row.profile_visibility, slug: row.profile_slug };
      });
    },
  };
}
