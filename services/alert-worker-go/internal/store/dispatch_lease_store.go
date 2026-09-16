package store

import (
	"context"
	"database/sql"
	"time"
)

// DispatchLeaseStore wraps the single-row mutual-exclusion lease added by
// migration 0129 (RT-04/RT-05). It is coarser than the per-delivery
// lease_token/lease_until on event_outbox_deliveries: this lease says "a
// dispatch run (scan + enqueue) is already in progress", so concurrent pump
// invocations -- a burst of post-commit webhook wake-ups, or a wake-up
// overlapping the scheduled outbox-recovery tick -- do not all list and
// enqueue the same backlog. It deliberately does not touch, and is not
// touched by, the per-delivery claim lease that app_private.claim_event_delivery
// sets later, at actual Cloud Task processing time.
type DispatchLeaseStore struct {
	db Queryer
}

func NewSQLDispatchLeaseStore(db *sql.DB) DispatchLeaseStore {
	return NewDispatchLeaseStore(sqlQueryer{db: db})
}

func NewDispatchLeaseStore(db Queryer) DispatchLeaseStore {
	return DispatchLeaseStore{db: db}
}

const acquireDispatchLeaseSQL = `select app_private.acquire_outbox_dispatch_lease($1::uuid, $2::timestamptz)`

const releaseDispatchLeaseSQL = `select app_private.release_outbox_dispatch_lease($1::uuid)`

// TryAcquire reports whether this call won the lease. false is not an
// error: it means another dispatch run currently holds it, so this run
// should do no work this tick.
func (s DispatchLeaseStore) TryAcquire(ctx context.Context, token string, until time.Time) (bool, error) {
	var acquired bool
	if err := s.db.QueryRowContext(ctx, acquireDispatchLeaseSQL, token, until).Scan(&acquired); err != nil {
		return false, err
	}
	return acquired, nil
}

// Release is best-effort: it is called on a graceful (non-crash) return
// from a dispatch run so a benign failure does not hold the backlog closed
// for the full lease window. A crash never reaches this call, and the
// lease then simply expires -- which is the recovery path, not an error.
func (s DispatchLeaseStore) Release(ctx context.Context, token string) error {
	var released bool
	return s.db.QueryRowContext(ctx, releaseDispatchLeaseSQL, token).Scan(&released)
}
