# Component test harness

`npm test` runs `tsx --test` (node:test) over every `*.test.ts`/`*.test.tsx`
under `app/`, preloading `dom-env.ts` first. That file builds one jsdom
window/document and copies it onto the Node global scope, so any test can
`render(...)` a real client component with no other setup.

## Adding a plain (non-component) test

Nothing changes — write `*.test.ts` with `node:test` + `node:assert/strict`
exactly as the existing 74 tests already do.

## Adding a component test

```tsx
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen } from '@testing-library/react';
import { MyComponent } from './MyComponent';

test('does the thing', () => {
  render(<MyComponent />);
  assert.equal(screen.getByRole('button', { name: 'Save' }).textContent, 'Save');
});
```

That's it for a component with no data fetching (see `app/components/ui/primitives.test.tsx`,
`app/components/StatusMessage.test.tsx`).

## Adding a test for a page that fetches data

Pages call `../lib/api` (creator surface) or `../viewer/lib/viewer-api.ts`
(viewer surface) directly — there's no dependency-injection seam, so a test
swaps the whole module via `mock-api.ts` / `mock-viewer-api.ts`, then
dynamically imports the page **after** mocking:

```tsx
import { mockApi } from '../test-support/mock-api';
import { controllable } from '../test-support/controllable';

const currentUser = controllable(async () => baseUser);
mockApi({ getCurrentUser: currentUser.fn, /* ...every other fn the page + AppShell call */ });

test('...', async () => {
  currentUser.set(async () => ({ ...baseUser, /* this test's variant */ }));
  const { default: Page } = await import(`./page?t=${Math.random()}`);
  render(<Page />);
  await waitFor(() => screen.getByText(/expected text/));
});
```

Two things that are NOT optional, both explained in comments in
`mock-api.ts`/`controllable.ts`:

- Call `mockApi(...)` **once per file**, at module scope, before any test
  imports the page. A second `mockApi(...)` call in the same file throws
  (`mock.module` refuses to re-mock an already-mocked specifier), and more
  importantly, anything the page transitively imports (`AppShell`,
  `useChannelBootstrap`, ...) only ever picks up whichever mock was active
  the *first* time it was loaded in this process — re-mocking later does
  not reach it.
- To vary the fixture per `test()`, wrap the function in `controllable(...)`
  and call `.set(...)` inside each test, then re-import the page with a
  cache-busting query string (`./page?t=${Math.random()}`) so you get a
  fresh component instance — its imports still resolve to the same
  `controllable` wrapper, which now calls your new fixture.
- Any page wrapped in `<AppShell>` also needs `getAccessToken`,
  `getTermsStatus`, `getBilling`, `getChannel` mocked (that's AppShell's own
  sidebar identity fetch) — see any file under `app/dashboard/` or
  `app/payments/page.test.tsx` for the fixed set.
- `app/test-support/fixtures.ts` has pre-filled, fully-typed
  `baseBillingView`/`baseChannelDetails(role)` — use them instead of
  hand-rolling a `BillingView`/`ChannelDetails` literal (tsc will catch a
  hand-rolled one that's missing a field, since these are real response
  types).

Run `npx tsc --noEmit` separately after adding tests — `npm test` does not
typecheck.

## Gotcha: do not mutate a `NEXT_PUBLIC_*` env var between dynamic imports

Reassigning a `NEXT_PUBLIC_*` variable between two
`await import('./page?t=' + Math.random())` calls **in the same test file** wedges
the second render — it hangs until the `waitFor` timeout, every time. Setting the
variable once and never mutating it passes.

Confirmed by isolated repro while covering the `NEXT_PUBLIC_ENABLE_BINDINGS_UI`
flag on the Alerts bindings UI. Root cause is not fully diagnosed; the suspicion is
transform-level env inlining or caching in esbuild/tsx rather than anything in React,
since the cache-busting query string defeats the module cache but not whatever the
transform captured.

**Work around it by splitting flag-on and flag-off coverage into separate test
files**, so each runs in its own process with the variable set once. See
`app/dashboard/alerts/binding-controls-enabled.test.tsx` and
`binding-controls-disabled.test.tsx` for the pattern.

This applies to any env-gated component, not just the bindings UI.

## Gotcha: `window.location.assign` cannot be mocked under this jsdom setup

`Object.defineProperty(window.location, 'assign', ...)` throws
`TypeError: Cannot redefine property: assign` — jsdom defines it as a
non-configurable, non-writable own property on the `Location` instance, and the
usual "replace window.location wholesale" trick does not apply here because
`dom-env.ts` copies a single jsdom window onto Node's globals.

So you **cannot assert the exact URL a redirect targets**. Assert the observable
effect instead — that the guarded content never renders, that the fetch which
should have been skipped was not made, and so on.

Example: `app/dashboard/DashboardClient.test.tsx` proves `getCurrentUser` stays
behind the terms gate by asserting the dashboard never renders and the call is
never made, rather than by asserting a navigation to `/accept-terms`.

If a future test genuinely needs the redirect target, the component has to take an
injectable navigation seam — changing the component, not the harness.

## Gotcha: `mock.timers` deadlocks every `waitFor` in the same test

Node's `node:test` `mock.timers` intercepts `setTimeout` **globally**, including the
one `@testing-library`'s `waitFor` polls with internally. Enabling it anywhere in a
test file makes every `waitFor` in that file hang until the runner's timeout.
Confirmed by isolated repro while covering `BillingActionsPanel.refreshBillingSoon`
(a 2s-delayed re-fetch).

There is no way to scope the fake clock to just the component's timer without an
injectable timer seam in the component — which is a source change, not a test one.

**For a short delay, just wait for real:**

```ts
await new Promise((resolve) => setTimeout(resolve, 2100));
```

Deterministic, leaves RTL's own timers alone, and costs ~2s per test. See
`app/dashboard/billing-refresh-soon.test.tsx`.

If a future component needs a longer delay tested, give it an injectable timer
rather than reaching for `mock.timers`.
