package ingress

import "sync"

// WakeupCoalescer collapses a burst of post-commit dispatcher wake-ups into a
// bounded number of actual wake-up calls.
//
// Why this exists (RT-04 correction, 2026-09-16). The wake-up added by RT-04
// was fire-and-forget but uncoalesced: every accepted webhook started its own
// goroutine and its own call to the alert-worker pump. Under a burst -- a raid,
// or a large creator's tip flood -- that is one unbounded goroutine and one
// redundant pump call per accepted webhook, all of which then contend for the
// single dispatch lease (RT-05) and all but one of which return a "skipped"
// outcome. The wake-up is a hint that work is ready, not the delivery itself;
// N hints for the same ready backlog carry no more information than one hint
// followed by one more hint.
//
// What "per channel" means here, stated honestly. The wake-up's shape is an
// HTTP POST of `{}` to the alert-worker's single `/internal/v1/tasks/pump`
// endpoint (see worker_pump.go), and webhook.Delivery carries only
// ProviderEventID and RawBodyHash -- there is no channel, creator or account
// identifier anywhere on this path, and RT-04's recorded design decision 3
// deliberately left the wake-up's shape unchanged. So this coalescer is not
// keyed by channel: the wake-up has exactly one target per process, therefore
// exactly one coalescing domain. That is strictly stronger than per-channel
// coalescing (a burst spanning many channels also collapses), and it is the
// bounded-data choice under §12.7: a per-channel map would be state keyed by
// externally-controlled identity, growing with traffic, which is the thing
// §12.7 forbids. Introducing a channel key here would require changing the
// wake-up's shape, which is out of this correction's scope.
//
// Bound, derived structurally rather than from an invented number: at most one
// wake-up goroutine exists per coalescer, there is one coalescer per dispatcher
// target, and the backlog of owed wake-ups is a single boolean flag rather than
// a queue. No configuration value and no numeric limit is introduced.
//
// The invariant, which is what makes coalescing safe for a hint: after any
// accepted webhook calls request, at least one complete wake-up run *begins*
// after that call recorded its demand. A wake-up already in flight when a new
// webhook arrives therefore causes exactly one more wake-up after it finishes,
// never zero. The last wake-up for a burst is never the one that gets dropped.
type WakeupCoalescer struct {
	mu sync.Mutex
	// running is true exactly while a wake-up goroutine is live.
	running bool
	// pending is the whole backlog: a wake-up is owed. It is a flag, not a
	// queue, because every owed wake-up asks for the identical thing.
	pending bool
	// trace and run belong to the most recent demand. Overwriting them is
	// correct: the coalesced wake-up is attributed to the most recent webhook
	// that asked for it, and every run func on one handler is equivalent.
	trace  string
	run    func(traceID string)
	closed bool
}

// NewWakeupCoalescer returns a coalescer with no wake-up owed and no goroutine
// running. The zero value is equally usable; this constructor exists so call
// sites read as a deliberate choice rather than an omission.
func NewWakeupCoalescer() *WakeupCoalescer {
	return &WakeupCoalescer{}
}

// request records that a wake-up is owed and guarantees that one more wake-up
// will begin after this call. It never blocks on the wake-up itself, so it is
// safe on the webhook's acknowledgement path: the 2xx never waits on it.
func (c *WakeupCoalescer) request(traceID string, run func(traceID string)) {
	if c == nil || run == nil {
		return
	}
	c.mu.Lock()
	if c.closed {
		// Shutdown has begun. Abandon the wake-up cleanly rather than start a
		// goroutine the process is about to leave behind. The durable commit
		// already happened and the scheduled outbox-recovery sweep still picks
		// the delivery up; nothing is lost, only delayed.
		c.mu.Unlock()
		return
	}
	c.pending = true
	c.trace = traceID
	c.run = run
	if c.running {
		// A wake-up is already in flight. It re-checks pending under this same
		// mutex before it exits, so it is guaranteed to see this demand and run
		// once more. Starting a second goroutine here would be the bug.
		c.mu.Unlock()
		return
	}
	c.running = true
	c.mu.Unlock()
	go c.loop()
}

// loop runs owed wake-ups one at a time until none is owed, then exits. It is
// the only goroutine this type ever creates, and only one of it exists at a
// time. pending is cleared under the mutex immediately before the run it
// satisfies, which is what closes the window: a request that observes
// running==true must have happened before this loop's exit check, so that
// check sees pending and loops instead of exiting.
func (c *WakeupCoalescer) loop() {
	for {
		c.mu.Lock()
		if c.closed || !c.pending {
			c.running = false
			c.mu.Unlock()
			return
		}
		c.pending = false
		traceID, run := c.trace, c.run
		c.mu.Unlock()
		run(traceID)
	}
}

// Close stops further wake-ups from being started. A wake-up already in flight
// is left to finish on its own bound (WorkerPumpClient's own timeout); a wake-up
// merely owed is abandoned. Close writes to no channel and closes nothing, so a
// request racing it can never panic or write after close -- it takes the mutex,
// sees closed, and returns. Close is idempotent and safe to call concurrently.
func (c *WakeupCoalescer) Close() {
	if c == nil {
		return
	}
	c.mu.Lock()
	c.closed = true
	c.pending = false
	c.mu.Unlock()
}

// idle reports that no wake-up is owed and none is running. It exists so tests
// can wait for quiescence without guessing at a duration.
func (c *WakeupCoalescer) idle() bool {
	if c == nil {
		return true
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return !c.running && !c.pending
}
