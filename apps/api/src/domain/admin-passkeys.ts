import { createHash, randomUUID } from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
type RegistrationResponseJSON = Parameters<typeof verifyRegistrationResponse>[0]['response'];

export type AdminWebAuthnConfig = {
  rpId: string;
  origins: string[];
  challengeTtlSeconds: number;
  mfaMaxAgeSeconds: number;
};

export type StoredPasskey = { credentialId: string; publicKey: Uint8Array; counter: number; transports: string[]; aaguid: string };
export type PendingPasskeyRecovery = { recoveryId: string; targetUserId: string; targetDisplayName: string; requestedAt: string; expiresAt: string; ownerApproved: boolean; staffApproved: boolean };
export type AdminPasskeyStore = {
  list(session: { userId: string; sessionId: string }): Promise<StoredPasskey[]>;
  begin(input: { userId: string; sessionId: string; challengeId: string; ceremony: 'registration' | 'authentication'; challengeHash: string; expiresAt: Date }): Promise<void>;
  finishRegistration(input: { userId: string; sessionId: string; challengeId: string; challengeHash: string; credentialId: string; publicKey: Uint8Array; counter: number; transports: string[]; aaguid: string }): Promise<void>;
  finishAssertion(input: { userId: string; sessionId: string; challengeId: string; challengeHash: string; credentialId: string; counter: number }): Promise<string>;
  isVerified(input: { userId: string; sessionId: string; maxAgeSeconds: number }): Promise<boolean>;
  requestRecovery(input: { userId: string; sessionId: string }): Promise<string>;
  listPendingRecoveries(input: { userId: string; sessionId: string }): Promise<PendingPasskeyRecovery[]>;
  approveRecovery(input: { userId: string; sessionId: string; recoveryId: string }): Promise<{ status: 'awaiting_second_approval' | 'completed'; completedAt: string | null }>;
};

export class AdminPasskeyError extends Error { constructor(public readonly code: 'unavailable' | 'invalid_response' | 'challenge_failed' | 'not_verified', message: string) { super(message); this.name = 'AdminPasskeyError'; } }
const challengeHash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
function responseChallenge(response: { response: { clientDataJSON: string } }): string {
  try {
    const parsed = JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString('utf8')) as { challenge?: unknown };
    if (typeof parsed.challenge !== 'string' || !/^[A-Za-z0-9_-]+$/.test(parsed.challenge) || parsed.challenge.length < 16 || parsed.challenge.length > 2048) throw new Error('bad');
    return parsed.challenge;
  } catch { throw new AdminPasskeyError('invalid_response', 'Passkey response has no valid challenge'); }
}

export class AdminPasskeyService {
  constructor(private readonly store: AdminPasskeyStore | undefined, private readonly config: AdminWebAuthnConfig | undefined) {}
  private ready(): { store: AdminPasskeyStore; config: AdminWebAuthnConfig } {
    if (!this.store || !this.config) throw new AdminPasskeyError('unavailable', 'Privileged passkey authentication is not configured');
    return { store: this.store, config: this.config };
  }
  async status(principal: { userId: string; sessionId: string }) {
    const { store, config } = this.ready();
    const passkeys = await store.list(principal);
    return { schemaVersion: 'v1' as const, hasPasskey: passkeys.length > 0, verified: await store.isVerified({ ...principal, maxAgeSeconds: config.mfaMaxAgeSeconds }) };
  }
  async registrationOptions(principal: { userId: string; sessionId: string }, userName: string) {
    const { store, config } = this.ready();
    const passkeys = await store.list(principal);
    if (passkeys.length > 0 && !await store.isVerified({ ...principal, maxAgeSeconds: config.mfaMaxAgeSeconds })) throw new AdminPasskeyError('not_verified', 'Verify an existing passkey before adding another');
    const options = await generateRegistrationOptions({ rpName: 'BharatStudio Admin', rpID: config.rpId, userID: principal.userId, userName, timeout: config.challengeTtlSeconds * 1000, attestationType: 'none', authenticatorSelection: { userVerification: 'required' }, excludeCredentials: passkeys.map((p) => ({ id: Buffer.from(p.credentialId, 'base64url'), type: 'public-key' as const, transports: p.transports as never })) });
    const id = randomUUID();
    await store.begin({ ...principal, challengeId: id, ceremony: 'registration', challengeHash: challengeHash(options.challenge), expiresAt: new Date(Date.now() + config.challengeTtlSeconds * 1000) });
    return { ceremonyId: id, options };
  }
  async verifyRegistration(principal: { userId: string; sessionId: string }, ceremonyId: string, response: RegistrationResponseJSON) {
    const { store, config } = this.ready();
    const challenge = responseChallenge(response);
    const verified = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: config.origins, expectedRPID: config.rpId, requireUserVerification: true });
    if (!verified.verified || !verified.registrationInfo?.userVerified) throw new AdminPasskeyError('invalid_response', 'Passkey registration could not be verified');
    const info = verified.registrationInfo;
    await store.finishRegistration({ ...principal, challengeId: ceremonyId, challengeHash: challengeHash(challenge), credentialId: Buffer.from(info.credentialID).toString('base64url'), publicKey: info.credentialPublicKey, counter: info.counter, transports: response.response.transports ?? [], aaguid: info.aaguid });
  }
  async assertionOptions(principal: { userId: string; sessionId: string }) {
    const { store, config } = this.ready();
    const passkeys = await store.list(principal);
    if (passkeys.length === 0) throw new AdminPasskeyError('not_verified', 'No passkey is enrolled for this admin');
    const options = await generateAuthenticationOptions({ rpID: config.rpId, timeout: config.challengeTtlSeconds * 1000, userVerification: 'required', allowCredentials: passkeys.map((p) => ({ id: Buffer.from(p.credentialId, 'base64url'), type: 'public-key' as const, transports: p.transports as never })) });
    const id = randomUUID();
    await store.begin({ ...principal, challengeId: id, ceremony: 'authentication', challengeHash: challengeHash(options.challenge), expiresAt: new Date(Date.now() + config.challengeTtlSeconds * 1000) });
    return { ceremonyId: id, options };
  }
  async verifyAssertion(principal: { userId: string; sessionId: string }, ceremonyId: string, response: Parameters<typeof verifyAuthenticationResponse>[0]['response']) {
    const { store, config } = this.ready();
    const challenge = responseChallenge(response);
    const passkey = (await store.list(principal)).find((entry) => entry.credentialId === response.id);
    if (!passkey) throw new AdminPasskeyError('invalid_response', 'Passkey is not active for this admin');
    const verified = await verifyAuthenticationResponse({ response, expectedChallenge: challenge, expectedOrigin: config.origins, expectedRPID: config.rpId, requireUserVerification: true, authenticator: { credentialID: Buffer.from(passkey.credentialId, 'base64url'), credentialPublicKey: passkey.publicKey, counter: passkey.counter, transports: passkey.transports as never } });
    if (!verified.verified || !verified.authenticationInfo.userVerified) throw new AdminPasskeyError('invalid_response', 'Passkey assertion could not be verified');
    return store.finishAssertion({ ...principal, challengeId: ceremonyId, challengeHash: challengeHash(challenge), credentialId: passkey.credentialId, counter: verified.authenticationInfo.newCounter });
  }
  async requestRecovery(principal: { userId: string; sessionId: string }) {
    const { store } = this.ready();
    return store.requestRecovery(principal);
  }
  async listPendingRecoveries(principal: { userId: string; sessionId: string }) {
    const { store } = this.ready();
    return store.listPendingRecoveries(principal);
  }
  async approveRecovery(principal: { userId: string; sessionId: string }, recoveryId: string) {
    const { store } = this.ready();
    return store.approveRecovery({ ...principal, recoveryId });
  }
}
