const RAZORPAY_SCRIPT_URL = 'https://checkout.razorpay.com/v1/checkout.js';

export type RazorpayOptions = {
  key: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  order_id: string;
  timeout: number;
  handler: () => void;
  modal: { ondismiss: () => void };
};

export type RazorpayInstance = { open: () => void };
export type RazorpayConstructor = new (options: RazorpayOptions) => RazorpayInstance;

declare global {
  interface Window {
    Razorpay?: RazorpayConstructor;
  }
}

function isExpectedScript(script: HTMLScriptElement): boolean {
  return script.src === RAZORPAY_SCRIPT_URL || script.getAttribute('src') === RAZORPAY_SCRIPT_URL;
}

/**
 * Load the provider checkout asset once, with a bounded failure. Payment
 * confirmation remains webhook/ledger-owned; this helper only controls the
 * browser handoff and never reports a payment result.
 */
export function loadRazorpayCheckout(timeoutMs = 8_000): Promise<RazorpayConstructor> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.reject(new Error('Payment checkout is unavailable'));
  }
  if (window.Razorpay) return Promise.resolve(window.Razorpay);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) {
    return Promise.reject(new Error('Payment checkout is unavailable'));
  }

  const existing = document.querySelector<HTMLScriptElement>('script[data-bharatstudio-razorpay]');
  if (existing && !isExpectedScript(existing)) {
    return Promise.reject(new Error('Payment checkout is unavailable'));
  }
  const script = existing ?? document.createElement('script');
  if (!existing) {
    script.src = RAZORPAY_SCRIPT_URL;
    script.async = true;
    script.dataset.bharatstudioRazorpay = 'true';
    document.head.appendChild(script);
  }

  return new Promise<RazorpayConstructor>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      script.removeEventListener('load', onLoad);
      script.removeEventListener('error', onError);
      if (error) reject(error);
      else if (window.Razorpay) resolve(window.Razorpay);
      else reject(new Error('Payment checkout is unavailable'));
    };
    const onLoad = () => finish();
    const onError = () => finish(new Error('Payment checkout could not load'));
    const timer = window.setTimeout(() => finish(new Error('Payment checkout could not load')), timeoutMs);
    script.addEventListener('load', onLoad, { once: true });
    script.addEventListener('error', onError, { once: true });
    // A script may have loaded between the initial check and listener setup.
    if (window.Razorpay) finish();
  });
}

