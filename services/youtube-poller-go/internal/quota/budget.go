// Package quota implements the poller's YouTube Data API quota model.
//
// Quota is the binding constraint on this whole feature (see L15 task doc):
// the Data API quota increase is an unresolved external dependency, so the
// poller must behave correctly and degrade gracefully at whatever quota
// Google actually grants — including the small default project quota
// (10,000 units/day) while the increase is pending.
//
// Model:
//   - A single process-wide Budget tracks units spent in the current UTC
//     day (Google's quota resets at midnight Pacific, but a conservative
//     UTC-day reset under-uses rather than over-uses quota — see Reset).
//   - Each poll cycle, every currently-live channel gets an equal share of
//     whatever budget remains for the cycle (RemainingForCycle), divided
//     across the channels live *right now*. A channel that is not live
//     draws nothing, and a single busy chat cannot starve others: it is
//     capped at its own share regardless of how many messages are waiting
//     in its chat.
//   - Spend is recorded as calls succeed, so the shrinking remainder is
//     re-divided on the next cycle among however many channels are still
//     live.
//   - Backoff: a quota error (HTTP 403 with reason "quotaExceeded" or
//     "dailyLimitExceeded", surfaced by internal/youtube as ErrQuotaExceeded)
//     stops all polling for the rest of the UTC day rather than retrying —
//     hammering a hard quota wall only risks the account being flagged.
package quota

import (
	"sync"
	"time"
)

// Costs in quota units, per the YouTube Data API v3 published cost table.
const (
	CostLiveChatMessagesList = 5
	CostLiveBroadcastsList   = 1
	CostVideosList           = 1

	// CostLiveChatMessagesStreamList is a placeholder, not a published
	// figure: Google does not document a per-call/per-connect unit cost
	// for streamList anywhere this task could find (checked the method
	// page, the liveChatMessages.list page, and the quota calculator).
	// Charged once per successful connect (see poller.streamOne) at the
	// same rate as one list call until real spend is observed against a
	// live, quota-metered project — see StreamUsage, which records
	// connects/messages per channel so that real number can be
	// back-computed from Google Cloud Console's quota graph after an
	// actual stream runs. Treat any budget math involving this constant
	// as an assumption, not a verified cost.
	CostLiveChatMessagesStreamList = CostLiveChatMessagesList
)

// Budget tracks units spent against a fixed daily allocation. DailyUnits
// should be set from the YOUTUBE_QUOTA_DAILY_UNITS environment variable —
// the actual grant Google has approved for this project, which starts at
// the default 10,000 and only rises once the quota-increase request is
// approved (external, unresolved; see governance/AGENTS.md:28 — this
// package makes no claim about that approval, it only spends whatever
// number it is configured with).
type Budget struct {
	mu         sync.Mutex
	dailyUnits int64
	spent      int64
	day        string // YYYY-MM-DD (UTC), the day `spent` is counted against
	now        func() time.Time
	exhausted  bool // set once a quota error is observed; cleared on Reset
}

func NewBudget(dailyUnits int64, now func() time.Time) *Budget {
	if now == nil {
		now = time.Now
	}
	return &Budget{dailyUnits: dailyUnits, now: now, day: now().UTC().Format("2006-01-02")}
}

// rolloverLocked resets spend when the UTC day has changed. Must be called
// with mu held.
func (b *Budget) rolloverLocked() {
	today := b.now().UTC().Format("2006-01-02")
	if today != b.day {
		b.day = today
		b.spent = 0
		b.exhausted = false
	}
}

// Remaining returns the units left in the current day's budget.
func (b *Budget) Remaining() int64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.rolloverLocked()
	if b.exhausted {
		return 0
	}
	remaining := b.dailyUnits - b.spent
	if remaining < 0 {
		return 0
	}
	return remaining
}

// Spend records units actually consumed by a successful call.
func (b *Budget) Spend(units int64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.rolloverLocked()
	b.spent += units
}

// MarkExhausted stops all spending for the rest of the UTC day — the
// backoff response to a quota error from the API itself, distinct from
// simply running the counted budget down to zero.
func (b *Budget) MarkExhausted() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.rolloverLocked()
	b.exhausted = true
}

// Exhausted reports whether a quota error has been observed today.
func (b *Budget) Exhausted() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.rolloverLocked()
	return b.exhausted
}

// FairShare divides whatever is left in the daily budget evenly across
// liveChannelCount channels that are live in the current poll cycle, so one
// busy channel's chat cannot consume another's share. It returns the unit
// allowance for a single channel this cycle — the caller stops polling
// deeper into that channel's chat once its share of the cycle is spent,
// even if the channel remains live and has more messages waiting.
//
// A degenerate liveChannelCount of 0 (nothing live) returns 0: nothing to
// share.
func FairShare(remaining int64, liveChannelCount int) int64 {
	if liveChannelCount <= 0 || remaining <= 0 {
		return 0
	}
	return remaining / int64(liveChannelCount)
}
