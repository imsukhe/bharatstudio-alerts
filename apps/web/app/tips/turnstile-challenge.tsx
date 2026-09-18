'use client';

import Script from 'next/script';
import { useCallback, useEffect, useRef, useState } from 'react';

/** Cloudflare's public browser loader. The verification secret never enters web code. */
export const turnstileScriptSrc = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

type TurnstileOptions = {
  sitekey: string;
  callback?: (token: string) => void;
  'expired-callback'?: () => void;
  'error-callback'?: () => void;
};

type TurnstileApi = {
  render: (container: HTMLElement, options: TurnstileOptions) => string;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

/** A site key is public configuration, but blank/malformed build input must not become a widget value. */
export function publicTurnstileSiteKey(value = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length <= 2048 ? normalized : undefined;
}

/**
 * Production's API is intentionally fail-closed when public-payment verification
 * is enabled. The browser therefore refuses a checkout it knows cannot supply a
 * response, rather than creating a request guaranteed to receive a 403.
 */
export function missingProductionTurnstileSiteKey(
  siteKey: string | undefined,
  nodeEnv: string = String(process.env.NODE_ENV ?? ''),
): boolean {
  return (nodeEnv === 'production' || nodeEnv === 'staging') && !siteKey;
}

type TurnstileChallengeProps = {
  siteKey: string | undefined;
  onToken: (token: string | null) => void;
  /** Increment after each order attempt; a response token is single-use. */
  resetNonce: number;
};

/**
 * Minimal client boundary around Cloudflare Turnstile. It does not validate a
 * token, persist one, or decide that a payment is allowed; the existing API guard
 * remains the only authority for verification.
 */
export function TurnstileChallenge({ siteKey, onToken, resetNonce }: TurnstileChallengeProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | undefined>(undefined);
  const onTokenRef = useRef(onToken);
  const handledResetNonce = useRef(resetNonce);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => { onTokenRef.current = onToken; }, [onToken]);

  const renderWidget = useCallback(() => {
    const container = containerRef.current;
    const turnstile = window.turnstile;
    if (!siteKey || !container || !turnstile || widgetIdRef.current) return;
    try {
      widgetIdRef.current = turnstile.render(container, {
        sitekey: siteKey,
        callback: (token) => onTokenRef.current(token.trim() || null),
        'expired-callback': () => onTokenRef.current(null),
        'error-callback': () => {
          onTokenRef.current(null);
          setLoadFailed(true);
        },
      });
      setLoadFailed(false);
    } catch {
      onTokenRef.current(null);
      setLoadFailed(true);
    }
  }, [siteKey]);

  useEffect(() => {
    renderWidget();
    return () => {
      const widgetId = widgetIdRef.current;
      if (widgetId) window.turnstile?.remove(widgetId);
      widgetIdRef.current = undefined;
    };
  }, [renderWidget]);

  useEffect(() => {
    if (handledResetNonce.current === resetNonce) return;
    handledResetNonce.current = resetNonce;
    onTokenRef.current(null);
    const widgetId = widgetIdRef.current;
    if (widgetId) window.turnstile?.reset(widgetId);
  }, [resetNonce]);

  if (!siteKey) return null;

  return (
    <div aria-live="polite">
      <Script id="bharatstudio-payment-turnstile" src={turnstileScriptSrc} strategy="afterInteractive" onLoad={renderWidget} onError={() => {
        onTokenRef.current(null);
        setLoadFailed(true);
      }} />
      <div ref={containerRef} aria-label="Security check" />
      {loadFailed ? <p className="error-text" role="alert">The security check could not load. Please refresh and try again.</p> : null}
    </div>
  );
}
