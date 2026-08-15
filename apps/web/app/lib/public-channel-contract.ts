export type PublicChannelResponse = {
  channelId: string;
  handle: string;
  displayName: string;
  acceptingTips: boolean;
  minimumTipPaise: number;
  publicConfigVersion: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HANDLE = /^[A-Za-z0-9._-]{1,64}$/;
const PUBLIC_FIELDS = new Set(['channelId', 'handle', 'displayName', 'acceptingTips', 'minimumTipPaise', 'publicConfigVersion']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function isSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

/** Parse only the narrow public-channel projection used by the donor page. */
export function parsePublicChannel(value: unknown): PublicChannelResponse | null {
  if (!isRecord(value) || !isUuid(value.channelId) || typeof value.handle !== 'string' || !HANDLE.test(value.handle)) return null;
  if (Object.keys(value).some((key) => !PUBLIC_FIELDS.has(key))) return null;
  if (typeof value.displayName !== 'string' || value.displayName.trim().length === 0 || value.displayName.length > 120) return null;
  if (typeof value.acceptingTips !== 'boolean' || !isSafeInteger(value.minimumTipPaise) || value.minimumTipPaise < 1_000 || value.minimumTipPaise > 1_000_000_000) return null;
  if (!isSafeInteger(value.publicConfigVersion) || value.publicConfigVersion < 1) return null;
  return {
    channelId: value.channelId,
    handle: value.handle,
    displayName: value.displayName,
    acceptingTips: value.acceptingTips,
    minimumTipPaise: value.minimumTipPaise,
    publicConfigVersion: value.publicConfigVersion,
  };
}
