/*
 * PRF-02.5/PRF-04: the Supporter Ticker is in this slice specifically to
 * prove bounded DOM with recycling. §19.5: "A ticker recycles its rows;
 * it does not append forever. An 8-hour stream must end with the same
 * node count it started with."
 *
 * DESIGN: a fixed pool of `rowPoolSize` row elements is created exactly
 * once, in activate(). Every later snapshot only ever WRITES into that
 * same pool (textContent + opacity/transform) — never appends, never
 * removes. The container's child count is therefore constant for the
 * life of the module, event count notwithstanding.
 *
 * DATA FLOW (matches master-canvas-connection.ts's philosophy): the
 * shared connection only tells this module WHEN to re-read
 * (`connection.subscribe`); the actual entries always come from the
 * module's own REST snapshot fetch — the same
 * `/v1/overlay-widgets/:overlayId/supporter-ticker` endpoint the existing
 * standalone widget already reads (apps/web/app/overlay/widgets/
 * supporter-ticker/[overlayId]/page.tsx). A fetch result is staged into
 * `dirty`/`latestEntries` and only APPLIED to the DOM inside render(),
 * which the shared rAF scheduler calls — so every DOM write funnels
 * through the one loop (§19.5), never from inside the async fetch
 * callback directly.
 *
 * STALE-DATA SAFETY (PRF-02.12): `fetchToken` invalidates any in-flight
 * fetch that is superseded by a newer one, or by deactivation — a slow
 * response can never land after a faster/later one, or after the module
 * has been torn down, and overwrite the screen with a stale value.
 */

import type { CanvasModuleDefinition } from '../master-canvas-runtime';
import type { MasterCanvasConnection } from '../master-canvas-connection';
import { defaultCanvasTextStyles, type CanvasTextStyle } from '../text-rendering';

export type SupporterTickerEntry = { viewerRef: string; tierLabel: string; supportedAt: string };

// Engineering default, not a product number — no authority states a
// ticker row-pool size. REFERRED to Opus in the task record's Numbers
// rule section; safe to tune later without changing the recycling
// mechanism this proves.
export const DEFAULT_TICKER_ROW_POOL_SIZE = 12;

export interface SupporterTickerModuleOptions {
  container: HTMLElement;
  connection: MasterCanvasConnection;
  fetchSnapshot: () => Promise<SupporterTickerEntry[] | null>;
  reducedMotion: () => boolean;
  textStyle?: CanvasTextStyle;
  rowPoolSize?: number;
}

export function createSupporterTickerModule(options: SupporterTickerModuleOptions): CanvasModuleDefinition {
  const rowPoolSize = options.rowPoolSize ?? DEFAULT_TICKER_ROW_POOL_SIZE;
  const textStyle = options.textStyle ?? defaultCanvasTextStyles().name;

  let rows: HTMLElement[] = [];
  let latestEntries: SupporterTickerEntry[] | null = null;
  let dirty = false;
  let unsubscribeConnection: (() => void) | undefined;
  let fetchToken = 0;

  function ensurePool() {
    if (rows.length === rowPoolSize) return;
    options.container.textContent = '';
    rows = [];
    const doc = options.container.ownerDocument;
    for (let i = 0; i < rowPoolSize; i += 1) {
      const row = doc.createElement('span');
      row.dataset.role = 'supporter-ticker-row';
      row.style.display = 'inline-block';
      row.style.fontFamily = textStyle.fontFamily;
      row.style.opacity = '0';
      row.style.transform = 'translateY(0)'; // composite-only baseline — PRF-03, never top/left/width/height
      row.style.transition = options.reducedMotion() ? 'none' : 'opacity 160ms ease, transform 160ms ease';
      options.container.appendChild(row);
      rows.push(row);
    }
  }

  async function refetch() {
    const token = ++fetchToken;
    const result = await options.fetchSnapshot().catch(() => null);
    if (token !== fetchToken) return; // superseded by a newer fetch, or by deactivate() — discard
    latestEntries = result;
    dirty = true;
  }

  return {
    key: 'supporter_ticker',
    activate() {
      ensurePool();
      unsubscribeConnection = options.connection.subscribe(() => { void refetch(); });
    },
    deactivate() {
      unsubscribeConnection?.();
      unsubscribeConnection = undefined;
      fetchToken += 1; // any in-flight fetch response is now discarded on arrival
      dirty = false;
    },
    render() {
      if (!dirty) return; // most frames are a no-op — cheap even while active
      dirty = false;
      ensurePool();
      const entries = (latestEntries ?? []).slice(0, rowPoolSize);
      // Batch: compute every row's next text/opacity first (no layout
      // reads at all here — pure string/number work), then write. No
      // offsetHeight/getBoundingClientRect anywhere in this pass.
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i]!;
        const entry = entries[i];
        if (entry) {
          const text = `${entry.viewerRef} · ${entry.tierLabel}`;
          if (row.textContent !== text) row.textContent = text;
          if (row.style.opacity !== '1') row.style.opacity = '1';
        } else if (row.style.opacity !== '0') {
          row.style.opacity = '0';
          row.textContent = '';
        }
      }
    },
  };
}
