// Trusted L15 boundary for L14 historical claims. The browser cannot supply
// providerUserId: only a completed, server-verified OAuth connection may.
export type VerifiedViewerPlatformIdentity = {
  providerUserId: string;
  displayName: string | undefined;
};

export interface ViewerPlatformIdentityVerifier {
  getVerifiedIdentity(viewerAccountId: string, provider: 'youtube'): Promise<VerifiedViewerPlatformIdentity | null>;
}
