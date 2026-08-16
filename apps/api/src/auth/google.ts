import { OAuth2Client } from 'google-auth-library';

export type GoogleIdentity = {
  subject: string;
  displayName: string | null;
  // Captured for email delivery (invoice/subscription events, DPDP export
  // delivery, overlay-expiry reminders) — previously deliberately discarded
  // since nothing consumed it. emailVerified mirrors Google's own claim;
  // an unverified address is stored but never trusted as a confirmed
  // recipient (see create_user_session's own upsert logic).
  email: string | null;
  emailVerified: boolean;
};

export interface GoogleIdentityVerifier {
  verify(idToken: string): Promise<GoogleIdentity>;
}

export function createGoogleIdentityVerifier(clientId: string): GoogleIdentityVerifier {
  const client = new OAuth2Client(clientId);
  return {
    async verify(idToken) {
      const ticket = await client.verifyIdToken({ idToken, audience: clientId });
      const payload = ticket.getPayload();
      if (!payload?.sub) throw new Error('Google identity has no subject');
      return {
        subject: payload.sub,
        displayName: payload.name?.trim().slice(0, 120) || null,
        email: payload.email?.trim().toLowerCase().slice(0, 320) || null,
        emailVerified: payload.email_verified === true,
      };
    },
  };
}
