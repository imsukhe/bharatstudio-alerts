package reconcile

import (
	"errors"
	"testing"
	"time"

	"github.com/bharatstudio/bharatstudio-alerts/services/payment-webhook-go/internal/provider"
)

var reconciliationNow = time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC)

func candidate() Candidate {
	return Candidate{
		IntentID:        "intent-1",
		ProviderOrderID: "order-1",
		ProviderReceipt: "receipt-1",
		AmountPaise:     5000,
		Currency:        "INR",
		Status:          "provider_created",
		ExpiresAt:       reconciliationNow.Add(15 * time.Minute),
	}
}

func order(status string, paid, due int64) provider.Order {
	return provider.Order{
		Entity:      "order",
		ID:          "order-1",
		AmountPaise: 5000,
		AmountDue:   due,
		AmountPaid:  paid,
		Currency:    "INR",
		Receipt:     "receipt-1",
		Status:      status,
	}
}

func TestEvaluateOpenUnexpiredOrderIsNoop(t *testing.T) {
	decision, err := Evaluate(candidate(), order("attempted", 0, 5000), reconciliationNow)
	if err != nil || decision.Action != ActionNoop {
		t.Fatalf("expected safe noop, decision=%+v err=%v", decision, err)
	}
}

func TestEvaluateOpenExpiredOrderExpiresOnlyLocalIntent(t *testing.T) {
	local := candidate()
	local.ExpiresAt = reconciliationNow.Add(-time.Second)
	decision, err := Evaluate(local, order("created", 0, 5000), reconciliationNow)
	if err != nil || decision.Action != ActionExpireLocalIntent {
		t.Fatalf("expected local expiry, decision=%+v err=%v", decision, err)
	}
}

func TestEvaluatePaidOrderQueuesPaymentRecovery(t *testing.T) {
	decision, err := Evaluate(candidate(), order("paid", 5000, 0), reconciliationNow)
	if err != nil || decision.Action != ActionQueuePaymentRecovery {
		t.Fatalf("expected payment recovery, decision=%+v err=%v", decision, err)
	}
}

func TestEvaluatePaidOrderNeverDirectlyMarksPayment(t *testing.T) {
	decision, err := Evaluate(candidate(), order("paid", 5000, 0), reconciliationNow)
	if err != nil || decision.Action == ActionNoop || decision.Action == ActionExpireLocalIntent {
		t.Fatalf("paid order must not be treated as unpaid, decision=%+v err=%v", decision, err)
	}
}

func TestEvaluateRejectsMismatchedOrder(t *testing.T) {
	providerOrder := order("paid", 5000, 0)
	providerOrder.AmountPaise = 6000
	_, err := Evaluate(candidate(), providerOrder, reconciliationNow)
	if !errors.Is(err, ErrOrderMismatch) {
		t.Fatalf("expected order mismatch, got %v", err)
	}
}

func TestEvaluateUnknownStatusRequiresManualReview(t *testing.T) {
	decision, err := Evaluate(candidate(), order("new_provider_state", 0, 5000), reconciliationNow)
	if !errors.Is(err, ErrUnsupportedState) || decision.Action != ActionManualReview {
		t.Fatalf("expected manual review for unknown state, decision=%+v err=%v", decision, err)
	}
}
