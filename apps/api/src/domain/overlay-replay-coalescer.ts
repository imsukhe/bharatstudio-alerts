// RT-02 §3.2 — per-channel deduplicated replay: "One replay per channel per
// event, shared across that channel's sessions — not one query per session."
//
// Single-flight keyed by caller-supplied key (channelId + cursor + limit).
// The first caller for a key becomes the leader and actually runs `fn`;
// concurrent callers for the SAME key await its result instead of running
// their own. Two binding rules from the task, both load-bearing:
//
//   (c) A leader's failure must not become a follower's failure. If the
//       leader's read throws, or resolves to `null` (its own session was
//       revoked between admission and the read), a follower does NOT
//       inherit that outcome — it falls back to its own read.
//   (d) Different cursors (or limits, or channels) are never coalesced —
//       trivially true because they are different keys.
//
// This module knows nothing about overlays, tokens or TypeScript-side URL
// composition; it only deduplicates concurrent async work by key. Whether a
// given call ended up "shared" (reused an in-flight leader's result) or
// "leader" (ran its own read, whether as the true leader or as a
// fallback-after-failure) is reported back so the caller can drive the
// RT-02 §3.4 replay counters without this module knowing about metrics.
export type ReplayCoalescer<T> = {
  run(key: string, fn: () => Promise<T | null>): Promise<{ result: T | null; shared: boolean }>;
};

export function createReplayCoalescer<T>(): ReplayCoalescer<T> {
  const inflight = new Map<string, Promise<T | null>>();

  return {
    async run(key, fn) {
      const existing = inflight.get(key);
      if (existing) {
        try {
          const result = await existing;
          if (result !== null) return { result, shared: true };
        } catch {
          // Leader failed; this caller falls back to its own read below.
        }
        return { result: await fn(), shared: false };
      }
      const promise = fn();
      inflight.set(key, promise);
      try {
        const result = await promise;
        return { result, shared: false };
      } finally {
        // Only ever removes this call's own entry: a later caller for the
        // same key that arrived while this was in flight already captured
        // `promise` as `existing` above and does not touch the map again.
        if (inflight.get(key) === promise) inflight.delete(key);
      }
    },
  };
}
