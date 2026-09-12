package quota

import (
	"testing"
	"time"
)

func TestBudgetSpendAndRemaining(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	budget := NewBudget(1000, func() time.Time { return now })

	if got := budget.Remaining(); got != 1000 {
		t.Fatalf("Remaining() = %d, want 1000", got)
	}
	budget.Spend(300)
	if got := budget.Remaining(); got != 700 {
		t.Fatalf("Remaining() after spend = %d, want 700", got)
	}
	budget.Spend(800)
	if got := budget.Remaining(); got != 0 {
		t.Fatalf("Remaining() after overspend = %d, want 0 (never negative)", got)
	}
}

func TestBudgetResetsOnUTCDayRollover(t *testing.T) {
	day1 := time.Date(2026, 1, 1, 23, 59, 0, 0, time.UTC)
	now := day1
	budget := NewBudget(1000, func() time.Time { return now })
	budget.Spend(1000)
	if got := budget.Remaining(); got != 0 {
		t.Fatalf("Remaining() = %d, want 0", got)
	}

	now = time.Date(2026, 1, 2, 0, 0, 1, 0, time.UTC)
	if got := budget.Remaining(); got != 1000 {
		t.Fatalf("Remaining() after day rollover = %d, want 1000 (fresh day)", got)
	}
}

func TestMarkExhaustedZeroesRemainingUntilNextDay(t *testing.T) {
	now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	budget := NewBudget(1000, func() time.Time { return now })
	budget.Spend(10) // barely touched — quota error can arrive well before the counted budget runs out
	budget.MarkExhausted()

	if got := budget.Remaining(); got != 0 {
		t.Fatalf("Remaining() after MarkExhausted = %d, want 0", got)
	}
	if !budget.Exhausted() {
		t.Fatal("Exhausted() = false, want true")
	}

	now = time.Date(2026, 1, 2, 0, 0, 1, 0, time.UTC)
	if budget.Exhausted() {
		t.Fatal("Exhausted() stayed true after day rollover, want false")
	}
	if got := budget.Remaining(); got != 1000 {
		t.Fatalf("Remaining() after day rollover = %d, want 1000", got)
	}
}

func TestFairShareDividesEvenlyAcrossLiveChannels(t *testing.T) {
	cases := []struct {
		name             string
		remaining        int64
		liveChannelCount int
		want             int64
	}{
		{"three channels split 300 evenly", 300, 3, 100},
		{"one busy channel gets the whole budget alone", 300, 1, 300},
		{"uneven split floors down, never over-allocates", 100, 3, 33},
		{"no live channels means no share", 100, 0, 0},
		{"no budget means no share even with live channels", 0, 5, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := FairShare(tc.remaining, tc.liveChannelCount); got != tc.want {
				t.Fatalf("FairShare(%d, %d) = %d, want %d", tc.remaining, tc.liveChannelCount, got, tc.want)
			}
		})
	}
}

// TestFairShareStarvationResistance is the direct expression of "one busy
// channel cannot starve others": with a fixed remaining budget, adding more
// live channels can only shrink (never grow) any individual channel's
// share, and every live channel gets a strictly positive share whenever
// there is budget left to divide.
func TestFairShareStarvationResistance(t *testing.T) {
	remaining := int64(1000)
	previous := FairShare(remaining, 1)
	for count := 2; count <= 10; count++ {
		share := FairShare(remaining, count)
		if share <= 0 {
			t.Fatalf("FairShare(%d, %d) = %d, want > 0 while budget remains", remaining, count, share)
		}
		if share > previous {
			t.Fatalf("FairShare(%d, %d) = %d, increased vs count=%d share %d", remaining, count, share, count-1, previous)
		}
		previous = share
	}
}
