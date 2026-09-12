'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useParams } from 'next/navigation';
import { getApiOrigin } from '../../../lib/api-origin';
import { isExactRecord } from './response-validation';

const POLL_MS = 15_000;

export function WidgetPoller<T>({ endpoint, field, isValid, render }: { endpoint: string; field: string; isValid(value: unknown): value is T; render(value: T): ReactNode }) {
  const params = useParams<{ overlayId: string }>();
  const [value, setValue] = useState<T | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    document.documentElement.classList.add('browser-overlay-document');
    document.body.classList.add('browser-overlay-document');
    const cleanup = () => {
      if (timer.current) window.clearInterval(timer.current);
      document.documentElement.classList.remove('browser-overlay-document');
      document.body.classList.remove('browser-overlay-document');
    };
    const token = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token');
    if (!params.overlayId || !token) { setUnavailable(true); return cleanup; }
    let cancelled = false;
    let origin: string;
    try { origin = getApiOrigin(); } catch { setUnavailable(true); return cleanup; }
    const poll = async () => {
      try {
        const response = await fetch(`${origin}/v1/overlay-widgets/${encodeURIComponent(params.overlayId)}/${endpoint}`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
        if (cancelled) return;
        if (!response.ok) { if (response.status === 401) { setUnavailable(true); setValue(null); } return; }
        const body: unknown = await response.json();
        if (!cancelled) {
          const keys = ['schemaVersion', field];
          const fieldValue = isExactRecord(body, keys) && body.schemaVersion === 'v1' ? body[field] : undefined;
          setUnavailable(false);
          setValue(isValid(fieldValue) ? fieldValue : null);
        }
      } catch { /* retain last safe render and retry */ }
    };
    void poll();
    timer.current = window.setInterval(() => void poll(), POLL_MS);
    return () => { cancelled = true; cleanup(); };
  }, [endpoint, field, isValid, params.overlayId]);

  return <div className="l16-widget-root">
    <style>{`.l16-widget-root{background:transparent;color:#fff;font-family:system-ui,sans-serif;padding:12px}.l16-widget-card{background:rgba(12,17,29,.86);border:1px solid rgba(255,255,255,.2);border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.35);display:inline-flex;flex-direction:column;gap:6px;max-width:min(680px,100%);padding:14px 18px}.l16-widget-card p{margin:0}.l16-widget-ticker{flex-direction:row;flex-wrap:wrap}.l16-widget-ticker span{white-space:nowrap}`}</style>
    {!unavailable && value !== null ? render(value) : null}
  </div>;
}
