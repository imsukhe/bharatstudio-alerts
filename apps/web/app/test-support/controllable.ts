/*
 * Lets one `mockApi(...)`/`mockViewerApi(...)` call (per test FILE — see
 * mock-api.ts) serve several different fixtures across several `test()`
 * blocks in that file. `mock.module` throws if the same module specifier
 * is mocked twice without an explicit `.restore()`, and a fresh call also
 * only rebinds modules imported AFTER it — anything already imported
 * (AppShell, useChannelBootstrap, ...) keeps its original binding forever
 * for the life of the process. A `controllable()` sidesteps both: mock the
 * export ONCE with a thin wrapper, then swap what the wrapper *calls*
 * between tests with `.set(...)` — every existing binding to the wrapper
 * keeps working because the wrapper's identity never changes, only its
 * behaviour does.
 */
export function controllable<Args extends unknown[], R>(initial: (...args: Args) => Promise<R>) {
  let impl = initial;
  const fn = (...args: Args): Promise<R> => impl(...args);
  return { fn, set: (next: (...args: Args) => Promise<R>) => { impl = next; } };
}
