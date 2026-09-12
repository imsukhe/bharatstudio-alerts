/*
 * Pure, DOM-free helpers for the hype-mode overlay widget — mirrors
 * ../goal/goal-widget-logic.ts's own pattern.
 */

export type OverlayHypeMode = {
  schemaVersion: 'v1'; meterPaise: number; thresholdPaise: number; reached: boolean;
  startedAt: string; endsAt: string; ended: boolean;
};

export function isOverlayHypeMode(value: unknown): value is OverlayHypeMode {
  if (!isExactRecord(value, ['schemaVersion', 'meterPaise', 'thresholdPaise', 'reached', 'startedAt', 'endsAt', 'ended'])) return false;
  return value.schemaVersion === 'v1' && isNonNegativeSafeInteger(value.meterPaise) && isNonNegativeSafeInteger(value.thresholdPaise)
    && typeof value.reached === 'boolean' && isIsoDateTime(value.startedAt) && isIsoDateTime(value.endsAt) && typeof value.ended === 'boolean';
}

export function hypeMeterPercent(state: Pick<OverlayHypeMode, 'meterPaise' | 'thresholdPaise'>): number {
  if (state.thresholdPaise <= 0) return 0;
  return Math.min(100, Math.round((state.meterPaise / state.thresholdPaise) * 100));
}

export function formatRupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN')}`;
}
import { isExactRecord, isIsoDateTime, isNonNegativeSafeInteger } from '../shared/response-validation';
