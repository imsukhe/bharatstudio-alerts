import { createCipheriv, createHash, randomBytes } from 'node:crypto';

export type NotificationTokenProtector = {
  fingerprint(token: string): string;
  encrypt(token: string): string;
};

function keyFromHex(value: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) throw new Error('NOTIFICATION_TOKEN_ENCRYPTION_KEY must be 64 hexadecimal characters');
  return Buffer.from(value, 'hex');
}

export function createNotificationTokenProtector(key: string | undefined): NotificationTokenProtector {
  if (!key) throw new Error('NOTIFICATION_TOKEN_ENCRYPTION_KEY is required');
  const encryptionKey = keyFromHex(key);
  return {
    fingerprint(token) {
      return createHash('sha256').update(token, 'utf8').digest('hex');
    },
    encrypt(token) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
      const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
      return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
    },
  };
}
