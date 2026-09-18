// L15 task 7/8/17 (10.3 item 17): TipIntent domain types. A TipIntent is
// created server-side from a parsed `!tip` chat command (see
// services/youtube-poller-go/internal/chatcommand — this file has no
// dependency on that package; the two communicate only through the HTTP
// request body of the internal creation route in routes/public.ts) and
// resolved/consumed through an OPAQUE token. The amount, display name and
// message never travel in a client-visible query parameter — only the
// token does — see db/tipintent-store.ts for the token's shape and
// packages/db/migrations/0097_v1_l15_tipintent_short_link.sql for how it
// is stored (fingerprint only, never the raw token).

export type TipIntentState = 'ready' | 'used' | 'expired' | 'unknown';

export type CreateTipIntentInput = {
  channelId: string;
  amountPaise: number;
  donorDisplayName?: string | null;
  message?: string | null;
  sourcePlatform: 'youtube';
  sourceChannelUserId?: string | null;
};

export type CreatedTipIntent = {
  token: string;
  expiresAt: string;
};

export type ResolvedTipIntent =
  | { state: 'unknown' }
  | {
      state: 'used' | 'expired';
      channelHandle: string;
      channelDisplayName: string;
    }
  | {
      state: 'ready';
      channelHandle: string;
      channelDisplayName: string;
      amountPaise: number;
      currency: 'INR';
      donorDisplayName: string | null;
      message: string | null;
    };

export type ReservedTipIntent = {
  state: 'reserved' | 'completed';
  /** Stable local payment-order id selected while the TipIntent row is locked. */
  orderId: string;
  /** Original payment-service idempotency key; never returned by public reads. */
  idempotencyKey: string;
  channelId: string;
  amountPaise: number;
  currency: 'INR';
  donorDisplayName: string | null;
  message: string | null;
};

export type TipIntentCheckoutReservation = ReservedTipIntent | { state: 'in_progress' | 'used' };

export interface TipIntentRepository {
  create(input: CreateTipIntentInput): Promise<CreatedTipIntent>;
  /** Read-only. Never mutates state, safe to call repeatedly (e.g. page polling). */
  resolve(token: string): Promise<ResolvedTipIntent>;
  /**
   * Atomically reserves the ready link's one stable payment-order identity,
   * without consuming the link. Repeating the original idempotency key gets
   * the same reservation; a different key learns only that a checkout is in
   * progress. null means unknown, used, or expired (call resolve() to map it
   * to a human-readable response). A matching key may also recover a
   * completed reservation when the original 201 response was lost.
   */
  reserveCheckout(token: string, idempotencyKey: string, orderId: string): Promise<TipIntentCheckoutReservation | null>;
  /** Marks a matching, successfully-created local order as the link's one use. */
  completeCheckout(token: string, orderId: string, idempotencyKey: string): Promise<boolean>;
}
