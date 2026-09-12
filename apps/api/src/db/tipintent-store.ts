import type { Sql } from 'postgres';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import type {
  ConsumedTipIntent,
  CreateTipIntentInput,
  CreatedTipIntent,
  ResolvedTipIntent,
  TipIntentRepository,
} from '../domain/tipintent-types.js';

// TOKEN DESIGN.
// Alphabet: Crockford Base32 (32 symbols, digits 0-9 + A-Z minus the
// visually-ambiguous I, L, O, U) — chosen because it is exactly what a
// human retypes correctly from a chat message on a phone keyboard: no
// lowercase/uppercase ambiguity (we normalize to uppercase on lookup), no
// 0/O or 1/I/L confusion.
// Length: 10 symbols => log2(32) * 10 = 50 bits of entropy per token.
// Lifetime: 30 minutes (set server-side in
// app_private.create_tip_intent — never trusted from the caller).
// Single-use: yes — app_private.consume_tip_intent is an atomic
// SELECT ... FOR UPDATE that can only ever succeed once per token.
// Brute-force resistance: the token is looked up only through
// GET /v1/public/tip-intents/:token, which is rate-limited (30/min per
// caller, see routes/public.ts). At that ceiling, exhausting a 2^50
// keyspace takes on the order of 10^12 minutes even with zero other
// defenses; the 30-minute expiry then shrinks the live-token target
// window from "the whole keyspace, forever" to "whichever handful of
// tokens are unexpired at any moment", which is what actually matters for
// this threat model.
export const TIPINTENT_TOKEN_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const TIPINTENT_TOKEN_LENGTH = 10;
export const TIPINTENT_TOKEN_PATTERN = '^[0-9A-Za-z]{10}$';

export function generateTipIntentToken(): string {
  let token = '';
  for (let i = 0; i < TIPINTENT_TOKEN_LENGTH; i++) {
    token += TIPINTENT_TOKEN_ALPHABET[randomInt(0, TIPINTENT_TOKEN_ALPHABET.length)];
  }
  return token;
}

// The raw token is never persisted (see migration 0097) — only this
// fingerprint is, exactly like youtube_channel_connections'
// access_token_fingerprint (0094). Nothing sensitive (amount, name,
// message) is derivable from the token or its hash: both are pure random
// identifiers with no encoded payload, unlike e.g. a signed JWT.
export function hashTipIntentToken(token: string): string {
  return createHash('sha256').update(token.toUpperCase()).digest('hex');
}

type CreateRow = { id: string; expires_at: Date };
type ResolveRow = {
  channel_handle: string;
  channel_display_name: string;
  amount_paise: number;
  currency: 'INR';
  donor_display_name: string | null;
  message: string | null;
  state: 'ready' | 'used' | 'expired';
};
type ConsumeRow = {
  channel_id: string;
  amount_paise: number;
  currency: 'INR';
  donor_display_name: string | null;
  message: string | null;
};

export function createTipIntentStore(sql: Sql): TipIntentRepository {
  return {
    async create(input: CreateTipIntentInput): Promise<CreatedTipIntent> {
      const token = generateTipIntentToken();
      const tokenHash = hashTipIntentToken(token);
      const rows = await sql<CreateRow[]>`
        select id, expires_at from app_private.create_tip_intent(
          ${randomUUID()}::uuid, ${input.channelId}::uuid, ${tokenHash},
          ${input.amountPaise}, ${input.donorDisplayName ?? null}, ${input.message ?? null},
          ${input.sourcePlatform}, ${input.sourceChannelUserId ?? null}, 30
        )
      `;
      const row = rows[0];
      if (!row) throw new Error('tip intent creation returned no row');
      return { token, expiresAt: row.expires_at.toISOString() };
    },

    async resolve(token: string): Promise<ResolvedTipIntent> {
      const tokenHash = hashTipIntentToken(token);
      const rows = await sql<ResolveRow[]>`
        select channel_handle, channel_display_name, amount_paise, currency, donor_display_name, message, state
          from app_private.get_tip_intent_by_token_hash(${tokenHash})
      `;
      const row = rows[0];
      if (!row) return { state: 'unknown' };
      if (row.state === 'ready') {
        return {
          state: 'ready',
          channelHandle: row.channel_handle,
          channelDisplayName: row.channel_display_name,
          amountPaise: row.amount_paise,
          currency: row.currency,
          donorDisplayName: row.donor_display_name,
          message: row.message,
        };
      }
      return { state: row.state, channelHandle: row.channel_handle, channelDisplayName: row.channel_display_name };
    },

    async consume(token: string, orderId: string): Promise<ConsumedTipIntent | null> {
      const tokenHash = hashTipIntentToken(token);
      const rows = await sql<ConsumeRow[]>`
        select channel_id, amount_paise, currency, donor_display_name, message
          from app_private.consume_tip_intent(${tokenHash}, ${orderId}::uuid)
      `;
      const row = rows[0];
      if (!row) return null;
      return {
        channelId: row.channel_id,
        amountPaise: row.amount_paise,
        currency: row.currency,
        donorDisplayName: row.donor_display_name,
        message: row.message,
      };
    },
  };
}
