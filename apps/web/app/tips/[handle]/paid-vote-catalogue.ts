import { fetchTipOrder } from '../tip-client';

export type PublicPaidVoteOption = { optionKey: string; label: string };
export type PublicPaidVoteDefinition = { definitionId: string; label: string; options: PublicPaidVoteOption[] };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const optionKeyPattern = /^[a-z0-9_-]{1,40}$/;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function asNonEmptyText(value: unknown, maximum: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum ? value : null;
}

export function parsePublicPaidVoteCatalogue(value: unknown): PublicPaidVoteDefinition[] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const envelope = value as Record<string, unknown>;
  if (!exactKeys(envelope, ['schemaVersion', 'items']) || envelope.schemaVersion !== 'v1' || !Array.isArray(envelope.items) || envelope.items.length > 8) return null;
  const seenDefinitions = new Set<string>();
  const parsed: PublicPaidVoteDefinition[] = [];
  for (const item of envelope.items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const definition = item as Record<string, unknown>;
    if (!exactKeys(definition, ['definitionId', 'label', 'options']) || typeof definition.definitionId !== 'string' || !uuidPattern.test(definition.definitionId) || seenDefinitions.has(definition.definitionId) || !asNonEmptyText(definition.label, 120) || !Array.isArray(definition.options) || definition.options.length < 1 || definition.options.length > 16) return null;
    const seenOptions = new Set<string>();
    const options: PublicPaidVoteOption[] = [];
    for (const option of definition.options) {
      if (!option || typeof option !== 'object' || Array.isArray(option)) return null;
      const candidate = option as Record<string, unknown>;
      if (!exactKeys(candidate, ['optionKey', 'label']) || typeof candidate.optionKey !== 'string' || !optionKeyPattern.test(candidate.optionKey) || seenOptions.has(candidate.optionKey) || !asNonEmptyText(candidate.label, 120)) return null;
      seenOptions.add(candidate.optionKey);
      options.push({ optionKey: candidate.optionKey, label: candidate.label as string });
    }
    seenDefinitions.add(definition.definitionId);
    parsed.push({ definitionId: definition.definitionId, label: definition.label as string, options });
  }
  return parsed;
}

export async function loadPublicPaidVoteCatalogue(apiOrigin: string, handle: string): Promise<PublicPaidVoteDefinition[] | null> {
  try {
    const response = await fetchTipOrder({
      url: `${apiOrigin}/v1/public/channels/${encodeURIComponent(handle)}/paid-votes`,
      init: { cache: 'no-store' },
      timeoutMs: 5_000,
    });
    if (!response.ok) return null;
    return parsePublicPaidVoteCatalogue(await response.json());
  } catch {
    return null;
  }
}
