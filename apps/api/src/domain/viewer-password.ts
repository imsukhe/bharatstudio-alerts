import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// House pattern already uses node:crypto directly in auth/session-store.ts
// (sha256 token hashing) rather than adding a new dependency; scrypt here
// follows the same convention for viewer account passwords.
const KEY_LENGTH = 64;

export function hashViewerPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, KEY_LENGTH).toString('hex');
  return `scrypt:${salt}:${derived}`;
}

export function verifyViewerPassword(password: string, stored: string | null): boolean {
  if (!stored) return false;
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = parts[1] ?? '';
  const expectedHex = parts[2] ?? '';
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = scryptSync(password, salt, KEY_LENGTH);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
