package ingress

import (
	"context"
	"fmt"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// gatedPumper holds its first wake-up open until the test releases it, and
// counts separately the wake-ups that began after the test declared every
// webhook accepted. That second count is what makes "at least one wake-up
// strictly after the last webhook" an ordering fact rather than a timing
// guess: the gate is set while the first wake-up is provably still blocked,
// so any later wake-up provably began after every webhook was accepted.
type gatedPumper struct {
	mu                sync.Mutex
	calls             int
	afterAllAccepted  int
	allAccepted       atomic.Bool
	startedFirst      chan struct{}
	releaseFirst      chan struct{}
	closeStartedFirst sync.Once
}

func newGatedPumper() *gatedPumper {
	return &gatedPumper{startedFirst: make(chan struct{}), releaseFirst: make(chan struct{})}
}

func (p *gatedPumper) Pump(context.Context) error {
	p.mu.Lock()
	p.calls++
	call := p.calls
	if p.allAccepted.Load() {
		p.afterAllAccepted++
	}
	p.mu.Unlock()
	if call == 1 {
		p.closeStartedFirst.Do(func() { close(p.startedFirst) })
		<-p.releaseFirst
	}
	return nil
}

func (p *gatedPumper) counts() (calls int, afterAllAccepted int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.calls, p.afterAllAccepted
}

// RT-04 correction, 2026-09-16. This is the direct proof of the coalescing
// invariant, and it is the test that fails if the pending flag is removed.
//
// It proves both halves at once:
//
//  1. Coalescing. n concurrent accepted webhooks produce strictly fewer than n
//     wake-up calls. With the first wake-up held open, an uncoalesced handler
//     starts a goroutine and a call per webhook, so the count reaches n; the
//     coalescer instead collapses every webhook that arrives while a wake-up is
//     in flight into the single pending flag.
//
//  2. The last wake-up is never the one dropped. The gate is set after every
//     webhook has been accepted and while the first wake-up is still provably
//     blocked, so no wake-up can yet have been counted past it. Releasing the
//     first wake-up must then produce at least one more -- exactly one more,
//     not zero -- and that one provably began after the last webhook was
//     accepted.
//
// Note on "the same channel": the wake-up carries no channel (see
// wakeup_coalescer.go). Every webhook here is a distinct provider delivery
// hitting the one dispatcher target, which is the single coalescing domain
// this service has.
func TestBurstOfWebhooksCoalescesIntoBoundedWakeups(t *testing.T) {
	const n = 64
	pumper := newGatedPumper()
	store := &concurrentStore{}
	coalescer := NewWakeupCoalescer()
	handler := Handler{Wakeups: coalescer, Secret: "secret", Store: store, Pumper: pumper}

	var requests sync.WaitGroup
	for index := 0; index < n; index++ {
		requests.Add(1)
		go func(index int) {
			defer requests.Done()
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, request(`{}`, "secret", fmt.Sprintf("event_coalesce_%d", index)))
		}(index)
	}

	// The first wake-up must actually start, or the rest of this test would
	// be proving nothing about an in-flight wake-up.
	select {
	case <-pumper.startedFirst:
	case <-time.After(5 * time.Second):
		close(pumper.releaseFirst)
		t.Fatal("the first wake-up never started")
	}

	requests.Wait()
	if calls := atomic.LoadInt64(&store.calls); calls != n {
		close(pumper.releaseFirst)
		t.Fatalf("store_calls=%d, want %d -- coalescing must collapse wake-ups, never commits", calls, n)
	}

	// Property 1, measured while the first wake-up is still blocked: an
	// uncoalesced handler would already be at n here.
	duringBurst, _ := pumper.counts()
	if duringBurst >= n {
		close(pumper.releaseFirst)
		t.Fatalf("wakeup calls during the burst=%d, want fewer than %d -- wake-ups were not coalesced", duringBurst, n)
	}

	pumper.allAccepted.Store(true)
	close(pumper.releaseFirst)
	waitForCondition(t, 5*time.Second, coalescer.idle)

	// Property 2: the demand recorded by the webhooks that arrived while the
	// first wake-up was in flight caused exactly one more wake-up, and it ran
	// after the last webhook was accepted.
	total, after := pumper.counts()
	if after < 1 {
		t.Fatalf("no wake-up ran after the last webhook was accepted (total=%d) -- the last wake-up was dropped", total)
	}
	if total >= n {
		t.Fatalf("total wakeup calls=%d, want fewer than %d", total, n)
	}
	t.Logf("coalesced: %d webhooks produced %d wake-ups, %d of them after the last webhook was accepted", n, total, after)
}

// A wake-up requested after Close is abandoned cleanly: no goroutine, no
// panic, no write to anything already torn down. The durable commit is
// untouched, so the scheduled outbox-recovery sweep still picks the delivery
// up -- the wake-up was only ever a latency hint.
func TestWakeupCoalescerAbandonsWorkAfterClose(t *testing.T) {
	coalescer := NewWakeupCoalescer()
	var ran atomic.Int64
	coalescer.Close()
	coalescer.Close() // idempotent
	coalescer.request("razorpay:event_after_close", func(string) { ran.Add(1) })
	if !coalescer.idle() {
		t.Fatal("a closed coalescer must not hold pending work or a running goroutine")
	}
	time.Sleep(20 * time.Millisecond)
	if ran.Load() != 0 {
		t.Fatalf("wake-ups ran after close=%d, want 0", ran.Load())
	}
}

// Sequential webhooks are not coalesced away: when nothing is in flight, each
// accepted webhook still gets its own wake-up. Coalescing must only collapse
// hints that overlap, never suppress the steady-state path.
func TestSequentialWebhooksEachGetTheirOwnWakeup(t *testing.T) {
	coalescer := NewWakeupCoalescer()
	pumper := &countingPumper{}
	handler := Handler{Wakeups: coalescer, Secret: "secret", Store: &concurrentStore{}, Pumper: pumper}

	for index := 0; index < 3; index++ {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request(`{}`, "secret", fmt.Sprintf("event_sequential_%d", index)))
		waitForCondition(t, 2*time.Second, coalescer.idle)
	}
	if calls := pumper.callCount(); calls != 3 {
		t.Fatalf("wakeup calls=%d, want 3 -- non-overlapping wake-ups must not be collapsed", calls)
	}
}
