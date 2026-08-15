export function parsePositiveEntitlementLimit(value: string | null | undefined, name: string): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`Invalid ${name} entitlement`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`Invalid ${name} entitlement`);
  return parsed;
}

export function hasReachedEntitlementLimit(currentCount: number, limit: number | null): boolean {
  if (!Number.isSafeInteger(currentCount) || currentCount < 0) throw new Error('Invalid entitlement count');
  return limit !== null && currentCount >= limit;
}
