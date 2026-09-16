// RT-10 (FULL-PRODUCT-DEFINITION.md §19.0, §31.18.0): a burst of widget or
// dashboard reads must never exhaust the capacity a payment path needs. This
// is the admission governor — an in-memory concurrency ceiling over
// `derived_read`-classified requests (see `read-priority.ts`), independent
// of and in addition to `derived-read-pool.ts`'s connection-count bound.
//
// Per §2 of the owning command: the value is never invented here. Unset
// means no ceiling — every derived read is admitted exactly as it is today,
// bounded only by the platform's own Cloud Run request-concurrency cap. Only
// when an operator configures `WIDGET_ANALYTICS_MAX_CONCURRENT_READS` does
// shedding begin at all.
//
// A shed request must never hang or silently degrade (RT-10.2): the caller
// gets an explicit rejection before any database work starts, so admission
// itself never performs I/O and never blocks.

export type ReadBackpressureOutcome = 'admitted' | 'shed';

export type ReadBackpressureAdmission =
  | { admitted: true; release: () => void }
  | { admitted: false };

export type ReadBackpressureGovernor = {
  /** Attempts to admit one derived read. Never throws, never awaits. */
  tryAdmit(): ReadBackpressureAdmission;
  readonly inFlight: number;
  readonly ceiling: number | undefined;
};

export type ReadBackpressureConfig = {
  /** RT-10 §3.1. Unset = no ceiling = today's behaviour, unchanged. */
  maxConcurrentDerivedReads?: number;
};

export function createReadBackpressureGovernor(
  config: ReadBackpressureConfig,
  onOutcome?: (outcome: ReadBackpressureOutcome) => void,
): ReadBackpressureGovernor {
  const ceiling = config.maxConcurrentDerivedReads;
  let inFlight = 0;

  return {
    get inFlight() {
      return inFlight;
    },
    get ceiling() {
      return ceiling;
    },
    tryAdmit(): ReadBackpressureAdmission {
      if (ceiling !== undefined && inFlight >= ceiling) {
        try {
          onOutcome?.('shed');
        } catch {
          // A metrics defect must never be the reason admission itself fails.
        }
        return { admitted: false };
      }
      inFlight += 1;
      try {
        onOutcome?.('admitted');
      } catch {
        // Same as above — observation never affects the outcome.
      }
      let released = false;
      return {
        admitted: true,
        release: () => {
          if (released) return;
          released = true;
          inFlight = Math.max(0, inFlight - 1);
        },
      };
    },
  };
}
