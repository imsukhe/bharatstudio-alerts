package store

import (
	"context"
	"database/sql"
	"time"
)

type Row interface {
	Scan(dest ...any) error
}

type Queryer interface {
	QueryRowContext(ctx context.Context, query string, args ...any) Row
}

type DeliveryStore struct {
	db Queryer
}

type sqlQueryer struct {
	db *sql.DB
}

func (q sqlQueryer) QueryRowContext(ctx context.Context, query string, args ...any) Row {
	return q.db.QueryRowContext(ctx, query, args...)
}

func NewSQLDeliveryStore(db *sql.DB) DeliveryStore {
	return NewDeliveryStore(sqlQueryer{db: db})
}

func NewDeliveryStore(db Queryer) DeliveryStore {
	return DeliveryStore{db: db}
}

type ClaimedDelivery struct {
	DeliveryID     string
	EventID        string
	ChannelID      string
	OutboxID       string
	QueueID        string
	BindingID      string
	SourcePriority int
	OverrideValues []byte
	TraceID        string
	AttemptNumber  int
	StateVersion   int64
}

type CompletedDelivery struct {
	DeliveryID   string
	StateVersion int64
	Status       string
}

const claimSQL = `
select delivery_id, event_id, channel_id, outbox_id, queue_id, binding_id, source_priority, override_values, trace_id, attempt_number, state_version
  from app_private.claim_event_delivery($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::bigint, $6::uuid, $7::timestamptz)`

const retrySQL = `
select delivery_id, state_version
  from app_private.retry_event_delivery($1::uuid, $2::uuid, $3::timestamptz, $4::text)`

const completeSQL = `
select delivery_id, state_version, status
  from app_private.complete_event_delivery($1::uuid, $2::uuid, $3::text)`

const releaseSQL = `
select delivery_id, state_version, status
  from app_private.release_event_delivery($1::uuid, $2::uuid)`

func (s DeliveryStore) Claim(ctx context.Context, deliveryID, eventID, outboxID string, attemptNumber int, stateVersion int64, leaseToken string, leaseUntil time.Time) (ClaimedDelivery, bool, error) {
	var delivery ClaimedDelivery
	err := s.db.QueryRowContext(ctx, claimSQL, deliveryID, eventID, outboxID, attemptNumber, stateVersion, leaseToken, leaseUntil).Scan(
		&delivery.DeliveryID,
		&delivery.EventID,
		&delivery.ChannelID,
		&delivery.OutboxID,
		&delivery.QueueID,
		&delivery.BindingID,
		&delivery.SourcePriority,
		&delivery.OverrideValues,
		&delivery.TraceID,
		&delivery.AttemptNumber,
		&delivery.StateVersion,
	)
	if err == sql.ErrNoRows {
		return ClaimedDelivery{}, false, nil
	}
	if err != nil {
		return ClaimedDelivery{}, false, err
	}
	return delivery, true, nil
}

func (s DeliveryStore) Retry(ctx context.Context, deliveryID, leaseToken string, nextActionAt time.Time, errorCode string) (bool, error) {
	var returnedID string
	var stateVersion int64
	err := s.db.QueryRowContext(ctx, retrySQL, deliveryID, leaseToken, nextActionAt, errorCode).Scan(&returnedID, &stateVersion)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return returnedID == deliveryID && stateVersion > 0, nil
}

func (s DeliveryStore) Complete(ctx context.Context, deliveryID, leaseToken, status string) (CompletedDelivery, bool, error) {
	var delivery CompletedDelivery
	err := s.db.QueryRowContext(ctx, completeSQL, deliveryID, leaseToken, status).Scan(
		&delivery.DeliveryID,
		&delivery.StateVersion,
		&delivery.Status,
	)
	if err == sql.ErrNoRows {
		return CompletedDelivery{}, false, nil
	}
	if err != nil {
		return CompletedDelivery{}, false, err
	}
	return delivery, true, nil
}

func (s DeliveryStore) Release(ctx context.Context, deliveryID, leaseToken string) (CompletedDelivery, bool, error) {
	var delivery CompletedDelivery
	err := s.db.QueryRowContext(ctx, releaseSQL, deliveryID, leaseToken).Scan(
		&delivery.DeliveryID,
		&delivery.StateVersion,
		&delivery.Status,
	)
	if err == sql.ErrNoRows {
		return CompletedDelivery{}, false, nil
	}
	if err != nil {
		return CompletedDelivery{}, false, err
	}
	return delivery, true, nil
}
