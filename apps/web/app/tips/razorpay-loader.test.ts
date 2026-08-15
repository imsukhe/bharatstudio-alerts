import assert from 'node:assert/strict';
import test from 'node:test';
import { loadRazorpayCheckout } from './[handle]/razorpay-loader';

function installBrowser(options: { scriptSrc?: string; loaded?: boolean; existing?: boolean } = {}) {
  const listeners = new Map<string, Set<() => void>>();
  const scriptSource = options.scriptSrc ?? 'https://checkout.razorpay.com/v1/checkout.js';
  const script = {
    src: scriptSource,
    dataset: { bharatstudioRazorpay: 'true' },
    getAttribute(name: string) { return name === 'src' ? scriptSource : null; },
    addEventListener(name: string, callback: () => void) {
      const bucket = listeners.get(name) ?? new Set<() => void>();
      bucket.add(callback);
      listeners.set(name, bucket);
    },
    removeEventListener(name: string, callback: () => void) { listeners.get(name)?.delete(callback); },
  } as unknown as HTMLScriptElement;
  const created: HTMLScriptElement[] = [];
  const oldWindow = globalThis.window;
  const oldDocument = globalThis.document;
  const fakeWindow = {
    Razorpay: options.loaded ? (class { open() {} }) : undefined,
    setTimeout,
    clearTimeout,
  } as unknown as Window & typeof globalThis;
  const fakeDocument = {
    querySelector: () => options.existing === false ? null : script,
    createElement: () => script,
    head: { appendChild: (node: HTMLScriptElement) => { created.push(node); } },
  } as unknown as Document;
  Object.assign(globalThis, { window: fakeWindow, document: fakeDocument });
  return {
    script,
    created,
    emit(name: string) { for (const callback of listeners.get(name) ?? []) callback(); },
    restore() { Object.assign(globalThis, { window: oldWindow, document: oldDocument }); },
  };
}

test('reuses an already-loaded provider without injecting another script', async () => {
  const browser = installBrowser({ loaded: true });
  try {
    const constructor = await loadRazorpayCheckout();
    assert.equal(typeof constructor, 'function');
    assert.equal(browser.created.length, 0);
  } finally { browser.restore(); }
});

test('rejects an existing marked script from an unexpected origin', async () => {
  const browser = installBrowser({ scriptSrc: 'https://attacker.invalid/checkout.js' });
  try {
    await assert.rejects(loadRazorpayCheckout(), /unavailable/);
    assert.equal(browser.created.length, 0);
  } finally { browser.restore(); }
});

test('fails within the bounded timeout when the provider asset stalls', async () => {
  const browser = installBrowser();
  try {
    await assert.rejects(loadRazorpayCheckout(1_000), /could not load/);
  } finally { browser.restore(); }
});

test('resolves only after the expected provider asset emits load and exposes the constructor', async () => {
  const browser = installBrowser();
  try {
    const pending = loadRazorpayCheckout(1_000);
    (window as Window & { Razorpay?: unknown }).Razorpay = class { open() {} };
    browser.emit('load');
    assert.equal(typeof await pending, 'function');
  } finally { browser.restore(); }
});

test('injects the exact provider asset when no marked script exists', async () => {
  const browser = installBrowser({ existing: false });
  try {
    const pending = loadRazorpayCheckout(1_000);
    assert.equal(browser.created.length, 1);
    assert.equal(browser.created[0]?.src, 'https://checkout.razorpay.com/v1/checkout.js');
    (window as Window & { Razorpay?: unknown }).Razorpay = class { open() {} };
    browser.emit('load');
    assert.equal(typeof await pending, 'function');
  } finally { browser.restore(); }
});
