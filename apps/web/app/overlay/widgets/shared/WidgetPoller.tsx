'use client';

import { type ReactNode } from 'react';
import { useParams } from 'next/navigation';
import { getApiOrigin } from '../../../lib/api-origin';
import { isExactRecord } from './response-validation';
import { useOverlayTransport, type SnapshotOutcome } from './overlay-transport';

const POLL_MS = 15_000;

// TRANSPORT: see ./overlay-transport.ts — this reads the SAME snapshot
// endpoint every call site here already used, now driven by a persistent
// connection to the existing overlay SSE stream (routes/overlay.ts,
// unmodified) instead of a bare `setInterval`; a slower fallback poll of
// this same endpoint keeps every widget below working if the stream is
// ever unavailable.
async function fetchWidgetSnapshot<T>(
  apiOrigin: string,
  token: string,
  overlayId: string,
  endpoint: string,
  field: string,
  isValid: (value: unknown) => value is T,
): Promise<SnapshotOutcome<T>> {
  try {
    const response = await fetch(`${apiOrigin}/v1/overlay-widgets/${encodeURIComponent(overlayId)}/${endpoint}`, {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (!response.ok) return response.status === 401 ? { status: 'unauthorized' } : { status: 'error' };
    const body: unknown = await response.json();
    const keys = ['schemaVersion', field];
    const fieldValue = isExactRecord(body, keys) && body.schemaVersion === 'v1' ? body[field] : undefined;
    return { status: 'ok', value: isValid(fieldValue) ? fieldValue : null };
  } catch {
    return { status: 'error' };
  }
}

export function WidgetPoller<T>({ endpoint, field, isValid, render }: { endpoint: string; field: string; isValid(value: unknown): value is T; render(value: T): ReactNode }) {
  const params = useParams<{ overlayId: string }>();
  const { value, unavailable } = useOverlayTransport<T>({
    overlayId: params.overlayId,
    // Not memoized: useOverlayTransport always reads the latest closure via
    // a ref, so a fresh function on every render (endpoint/field/isValid are
    // themselves stable props in every current call site) is safe.
    fetchSnapshot: (apiOrigin, token, overlayId) => fetchWidgetSnapshot(apiOrigin, token, overlayId, endpoint, field, isValid),
    getApiOrigin,
    fallbackPollMs: POLL_MS,
  });

  return <div className="l16-widget-root">
    <style>{`.l16-widget-root{background:transparent;color:#fff;font-family:system-ui,sans-serif;padding:12px}.l16-widget-card{background:rgba(12,17,29,.86);border:1px solid rgba(255,255,255,.2);border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.35);display:inline-flex;flex-direction:column;gap:6px;max-width:min(680px,100%);padding:14px 18px}.l16-widget-card p{margin:0}.l16-widget-ticker{flex-direction:row;flex-wrap:wrap}.l16-widget-ticker span{white-space:nowrap}`}</style>
    {!unavailable && value !== null ? render(value) : null}
  </div>;
}
