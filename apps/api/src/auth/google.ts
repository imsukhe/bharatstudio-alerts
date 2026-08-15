import { OAuth2Client } from 'google-auth-library';

export type GoogleIdentity = {
  subject: string;
  displayName: string | null;
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
      };
    },
  };
}
