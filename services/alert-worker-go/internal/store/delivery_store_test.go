package store

import (
	"context"
	"database/sql"
	"strings"
	"testing"
	"time"
)

type fakeRow struct {
	values []any
	err    error
}

func (r fakeRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	for index := range dest {
		switch target := dest[index].(type) {
		case *string:
			*target = r.values[index].(string)
		case *int:
			*target = r.values[index].(int)
		case *int64:
			*target = r.values[index].(int64)
		case *[]byte:
			*target = r.values[index].([]byte)
		}
	}
	return nil
}

type fakeQueryer struct {
	query string
	args  []any
	row   Row
}

func (q *fakeQueryer) QueryRowContext(_ context.Context, query string, args ...any) Row {
	q.query = query
	q.args = args
	return q.row
}

func TestClaimUsesWorkerFunctionAndMapsNoRowsToNotClaimed(t *testing.T) {
	queryer := &fakeQueryer{row: fakeRow{err: sql.ErrNoRows}}
	store := NewDeliveryStore(queryer)
	_, claimed, err := store.Claim(context.Background(), "delivery-1", "event-1", "outbox-1", 1, 1, "lease-1", time.Now().Add(time.Minute))
	if err != nil || claimed {
		t.Fatalf("claimed=%v err=%v", claimed, err)
	}
	if !strings.Contains(queryer.query, "app_private.claim_event_delivery") {
		t.Fatalf("query did not use private claim function: %s", queryer.query)
	}
}

func TestClaimMapsRoutingSnapshot(t *testing.T) {
	queryer := &fakeQueryer{row: fakeRow{values: []any{
		"delivery-1", "event-1", "channel-1", "outbox-1", "queue-1", "binding-1",
		20, []byte(`{"style":"payment"}`), "trace-1", 1, int64(2),
	}}}
	store := NewDeliveryStore(queryer)
	delivery, claimed, err := store.Claim(context.Background(), "delivery-1", "event-1", "outbox-1", 1, 1, "lease-1", time.Now().Add(time.Minute))
	if err != nil || !claimed || delivery.SourcePriority != 20 || string(delivery.OverrideValues) != `{"style":"payment"}` {
		t.Fatalf("delivery=%+v claimed=%v err=%v", delivery, claimed, err)
	}
}

func TestRetryAndCompleteUsePrivateFunctions(t *testing.T) {
	queryer := &fakeQueryer{row: fakeRow{values: []any{"delivery-1", int64(3)}}}
	store := NewDeliveryStore(queryer)
	if ok, err := store.Retry(context.Background(), "delivery-1", "lease-1", time.Now().Add(time.Minute), "overlay_timeout"); err != nil || !ok {
		t.Fatalf("retry ok=%v err=%v", ok, err)
	}
	if !strings.Contains(queryer.query, "app_private.retry_event_delivery") {
		t.Fatalf("query did not use private retry function: %s", queryer.query)
	}

	queryer.row = fakeRow{values: []any{"delivery-1", int64(4), "displayed"}}
	completed, ok, err := store.Complete(context.Background(), "delivery-1", "lease-1", "displayed")
	if err != nil || !ok || completed.Status != "displayed" {
		t.Fatalf("completed=%+v ok=%v err=%v", completed, ok, err)
	}
	if !strings.Contains(queryer.query, "app_private.complete_event_delivery") {
		t.Fatalf("query did not use private completion function: %s", queryer.query)
	}
}

func TestSQLConstructorsWrapDatabaseHandles(t *testing.T) {
	var db *sql.DB
	storeValue := NewSQLDeliveryStore(db)
	notifier := NewSQLWakeupNotifier(db)
	if storeValue.db == nil || notifier.db == nil {
		t.Fatal("SQL constructors did not retain the database handle")
	}
}
