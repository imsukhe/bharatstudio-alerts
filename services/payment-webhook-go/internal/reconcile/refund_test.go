package reconcile

import (
	"context"
	"errors"
	"testing"

	"github.com/bharatstudio/bharatstudio-alerts/services/payment-webhook-go/internal/provider"
)

type fakeRefundStore struct {
	candidates  []RefundCandidate
	updated     []string
	quarantined []string
}

func (s *fakeRefundStore) ListRefundCandidates(context.Context, int) ([]RefundCandidate, error) {
	return s.candidates, nil
}

func (s *fakeRefundStore) ApplyRefundReconciliation(_ context.Context, candidate RefundCandidate, _ provider.Refund) error {
	s.updated = append(s.updated, candidate.RefundID)
	return nil
}
func (s *fakeRefundStore) QuarantineRefund(_ context.Context, id, reason string) (bool, error) {
	s.quarantined = append(s.quarantined, id+":"+reason)
	return true, nil
}

type fakeRefundProvider struct {
	refund provider.Refund
	err    error
}

func (p fakeRefundProvider) FetchRefundForAccount(context.Context, string, string) (provider.Refund, error) {
	return p.refund, p.err
}

func TestRefundRunnerAppliesOnlyMatchingProcessedRefund(t *testing.T) {
	candidate := RefundCandidate{RefundID: "refund-local", ProviderRefundID: "rfnd_123", ProviderPaymentID: "pay_123", AmountPaise: 2500, Currency: "INR", Status: "requested"}
	store := &fakeRefundStore{candidates: []RefundCandidate{candidate}}
	runner := RefundRunner{
		Store:    store,
		Provider: fakeRefundProvider{refund: provider.Refund{Entity: "refund", ID: "rfnd_123", AmountPaise: 2500, Currency: "INR", PaymentID: "pay_123", Status: "processed"}},
	}
	summary, err := runner.RunOnce(context.Background(), 20)
	if err != nil || summary.Updated != 1 || len(store.updated) != 1 {
		t.Fatalf("summary=%+v err=%v updated=%v", summary, err, store.updated)
	}
}

func TestRefundRunnerQuarantinesIdentityMismatchAsRetryableReview(t *testing.T) {
	candidate := RefundCandidate{RefundID: "refund-local", ProviderRefundID: "rfnd_123", ProviderPaymentID: "pay_123", AmountPaise: 2500, Currency: "INR", Status: "requested"}
	store := &fakeRefundStore{candidates: []RefundCandidate{candidate}}
	runner := RefundRunner{
		Store:    store,
		Provider: fakeRefundProvider{refund: provider.Refund{Entity: "refund", ID: "rfnd_123", AmountPaise: 5000, Currency: "INR", PaymentID: "pay_123", Status: "processed"}},
	}
	summary, err := runner.RunOnce(context.Background(), 20)
	if !errors.Is(err, ErrPartialRun) || summary.ManualReview != 1 || len(store.updated) != 0 || len(store.quarantined) != 1 {
		t.Fatalf("summary=%+v err=%v updated=%v", summary, err, store.updated)
	}
}
