/*
 * Component-test harness entry point (see README.md in this directory for
 * how to add a test). This file only sets up the jsdom global environment
 * — it is preloaded via `--import` on the `npm test` command, before any
 * *.test.tsx file runs, so every component test gets a `document`/`window`
 * for free without importing anything itself.
 */
import { JSDOM } from 'jsdom';
import { afterEach } from 'node:test';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:3100/',
  pretendToBeVisual: true,
});

const { window } = dom;

const globalsToCopy = [
  'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement',
  'HTMLFormElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'Node', 'Element', 'Event',
  'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'InputEvent', 'FocusEvent', 'DocumentFragment',
  'SVGElement', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'Text',
] as const;

for (const key of globalsToCopy) {
  const value = (window as unknown as Record<string, unknown>)[key];
  if (value === undefined) continue;
  // `navigator` (and a few others) are getter-only own properties on the
  // Node 24+ global object (Node ships its own built-in `navigator`) — a
  // plain assignment throws. Redefine the property instead of assigning it.
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true, enumerable: true });
}

// next/link's client-side prefetch code (next/dist/client/use-intersection)
// reads `self` and `self.IntersectionObserver` directly (it assumes a
// browser global, not jsdom's `window`-only globals) — without this, any
// component that renders a next/link <Link> throws `self is not defined`.
if (!('self' in globalThis)) {
  // @ts-expect-error -- browser-only global, standard polyfill shape.
  globalThis.self = globalThis;
}
if (!('IntersectionObserver' in globalThis)) {
  // @ts-expect-error -- minimal stub; component tests don't assert on
  // prefetch-on-scroll-into-view behaviour, only that a Link renders.
  globalThis.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

if (!('requestAnimationFrame' in globalThis)) {
  // @ts-expect-error -- jsdom (pretendToBeVisual notwithstanding) doesn't always provide this.
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0);
  globalThis.cancelAnimationFrame = (handle: number) => clearTimeout(handle);
}

// React reads this to decide whether it's safe to batch/act-wrap updates.
// @ts-expect-error -- global test flag, not part of any lib.dom typing.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(async () => {
  const { cleanup } = await import('@testing-library/react');
  cleanup();
});
