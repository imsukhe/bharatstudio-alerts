import { OAuth2Client } from 'google-auth-library';
import type { ServiceIdentityVerifier } from '../domain/maintenance.js';

export function createGoogleServiceIdentityVerifier(audiences: string[]): ServiceIdentityVerifier {
  const allowed = new Set(audiences.map((value) => value.trim()).filter(Boolean));
  if (allowed.size === 0) throw new Error('at least one internal service audience is required');
  const client = new OAuth2Client();
  return {
    async verify(authorizationHeader) {
      const parts = (authorizationHeader ?? '').trim().split(/\s+/);
      const scheme = parts[0] ?? '';
      const token = parts[1] ?? '';
      if (parts.length !== 2 || scheme.toLowerCase() !== 'bearer' || !token) return false;
      try {
        const ticket = await client.verifyIdToken({ idToken: token, audience: [...allowed] });
        const payload = ticket.getPayload();
        return Boolean(payload?.sub && payload.email_verified !== false);
      } catch {
        return false;
      }
    },
  };
}
