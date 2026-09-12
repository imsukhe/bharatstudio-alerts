/**
 * Batch 3: viewer password reset. Kept as its own small store/interface
 * (viewer-reset-* naming) rather than folded directly into viewer-store.ts,
 * then composed into the single ViewerStore object index.ts already
 * constructs — see db/viewer-store.ts's delegation and its own comment for
 * why this couldn't be wired as a fully separate dependency.
 */
export interface ViewerPasswordResetStore {
  /**
   * Always resolves, regardless of whether `email` matches a viewer
   * account. This is the account-enumeration defence: the SQL layer
   * (app_private.request_viewer_password_reset, migration 0088) is a
   * silent no-op on no match, so there is nothing here to branch on either
   * — the caller must send back one identical response either way.
   */
  requestReset(email: string): Promise<void>;
  /**
   * Resolves false for an invalid, already-used, or expired token. The
   * caller must not distinguish between those cases in its response (same
   * enumeration-style reasoning — which failure occurred is not this
   * surface's information to leak).
   */
  resetPassword(token: string, newPassword: string): Promise<boolean>;
}
