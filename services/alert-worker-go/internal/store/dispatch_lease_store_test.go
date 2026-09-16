package store

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestTryAcquireUsesPrivateFunctionAndReturnsWhetherItWon(t *testing.T) {
	queryer := &fakeQueryer{row: fakeRow{values: []any{true}}}
	leaseStore := NewDispatchLeaseStore(queryer)
	acquired, err := leaseStore.TryAcquire(context.Background(), "token-1", time.Now().Add(time.Minute))
	if err != nil || !acquired {
		t.Fatalf("acquired=%v err=%v", acquired, err)
	}
	if !strings.Contains(queryer.query, "app_private.acquire_outbox_dispatch_lease") {
		t.Fatalf("query did not use the private acquire function: %s", queryer.query)
	}
}

func TestTryAcquireReportsFalseWithoutErrorWhenAnotherRunHoldsTheLease(t *testing.T) {
	queryer := &fakeQueryer{row: fakeRow{values: []any{false}}}
	leaseStore := NewDispatchLeaseStore(queryer)
	acquired, err := leaseStore.TryAcquire(context.Background(), "token-1", time.Now().Add(time.Minute))
	if err != nil {
		t.Fatalf("expected a lost race for the lease to be a normal, non-error outcome: %v", err)
	}
	if acquired {
		t.Fatal("expected acquire to report false when another run already holds the lease")
	}
}

func TestTryAcquirePropagatesAQueryFailure(t *testing.T) {
	queryer := &fakeQueryer{row: fakeRow{err: errors.New("connection reset")}}
	leaseStore := NewDispatchLeaseStore(queryer)
	if _, err := leaseStore.TryAcquire(context.Background(), "token-1", time.Now().Add(time.Minute)); err == nil {
		t.Fatal("expected a database failure to surface as an error, not a lost race")
	}
}

func TestReleaseUsesPrivateFunction(t *testing.T) {
	queryer := &fakeQueryer{row: fakeRow{values: []any{true}}}
	leaseStore := NewDispatchLeaseStore(queryer)
	if err := leaseStore.Release(context.Background(), "token-1"); err != nil {
		t.Fatalf("release: %v", err)
	}
	if !strings.Contains(queryer.query, "app_private.release_outbox_dispatch_lease") {
		t.Fatalf("query did not use the private release function: %s", queryer.query)
	}
}

func TestReleaseIsANoOpErrorFreeWhenThisRunDidNotHoldTheLease(t *testing.T) {
	queryer := &fakeQueryer{row: fakeRow{values: []any{false}}}
	leaseStore := NewDispatchLeaseStore(queryer)
	if err := leaseStore.Release(context.Background(), "token-1"); err != nil {
		t.Fatalf("a release of a lease this token never held must not be an error: %v", err)
	}
}
