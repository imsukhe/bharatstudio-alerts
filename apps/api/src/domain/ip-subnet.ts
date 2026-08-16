import { createHash } from 'node:crypto';

// Referral fraud signal: same-subnet reuse across a single referrer's own
// referred channels. Only a hash of a masked subnet is ever stored — never
// a raw IP — matching the "hashes only" pattern the rest of this codebase
// already uses for other identifiers (see e.g. session-store.ts's token
// hash). Masking happens server-side so the value cannot be spoofed by a
// client-supplied header.
export function computeIpSubnetHash(rawIp: string | undefined | null): string | null {
  if (!rawIp) return null;
  const ip = rawIp.trim();
  if (ip.length === 0) return null;

  const ipv4Match = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/i.exec(ip);
  if (ipv4Match) {
    const [, a, b, c] = ipv4Match;
    const octets = [a, b, c].map((part) => Number(part));
    if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
    return createHash('sha256').update(`v4:${octets.join('.')}.0/24`, 'utf8').digest('hex');
  }

  if (ip.includes(':')) {
    // A coarse heuristic, not a full IPv6 prefix parser: for a compressed
    // address ("::1", "2001:db8::1") this takes the first up-to-3 written
    // hextets rather than resolving the "::" collapse, which can under-mask
    // some addresses. That only ever makes the same-subnet signal miss a
    // true match (never fabricate a false one), which is the safe direction
    // for a fraud signal to be imprecise in.
    const hextets = ip.split(':').filter((part) => part.length > 0).slice(0, 3);
    if (hextets.length === 0) return null;
    return createHash('sha256').update(`v6:${hextets.join(':')}::/48`, 'utf8').digest('hex');
  }

  return null;
}
