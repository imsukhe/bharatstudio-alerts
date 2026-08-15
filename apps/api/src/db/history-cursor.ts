const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type HistoryCursor = {
  createdAt: string;
  eventId: string | null;
};

/**
 * History cursors are opaque to clients, but are deliberately bounded and
 * validateable at the API boundary. The timestamp-only form remains accepted
 * for callers holding a cursor issued before the tie-breaker migration.
 */
export function parseHistoryCursor(value: string | undefined): HistoryCursor | undefined {
  if (value === undefined) return undefined;

  const separator = value.indexOf('|');
  if (separator === -1) {
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? undefined : { createdAt: date.toISOString(), eventId: null };
  }
  if (value.indexOf('|', separator + 1) !== -1) return undefined;

  const date = new Date(value.slice(0, separator));
  const eventId = value.slice(separator + 1);
  if (Number.isNaN(date.valueOf()) || !UUID_PATTERN.test(eventId)) return undefined;
  return { createdAt: date.toISOString(), eventId: eventId.toLowerCase() };
}

export function formatHistoryCursor(createdAt: Date, eventId: string): string {
  if (!UUID_PATTERN.test(eventId)) throw new Error('history event id is not a UUID');
  return `${createdAt.toISOString()}|${eventId.toLowerCase()}`;
}
