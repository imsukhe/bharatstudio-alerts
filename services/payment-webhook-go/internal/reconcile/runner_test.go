package reconcile

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/bharatstudio/bharatstudio-alerts/services/payment-webhook-go/internal/provider"
)

type fakeStore struct {
	candidates []Candidate
	expired    []string
	recovery   []string
}

func (s *fakeStore) ListCandidates(context.Context, int) ([]Candidate, error) {
	return s.candidates, nil
}
func (s *fakeStore) ExpireLocalIntent(_ context.Context, id, _ string) (bool, error) {
	s.expired = append(s.expired, id)
	return true, nil
}
func (s *fakeStore) QueuePaymentRecovery(_ context.Context, id, _ string, _ time.Time) (bool, error) {
	s.recovery = append(s.recovery, id)
	return true, nil
}

type fakeProvider struct {
	orders map[string]provider.Order
	err    error
}

func (p fakeProvider) FetchOrderForAccount(_ context.Context, _ string, id string) (provider.Order, error) {
	if p.err != nil {
		return provider.Order{}, p.err
	}
	return p.orders[id], nil
}

type fakeRecoveryProvider struct {
	payments map[string][]provider.Payment
}

func (p fakeRecoveryProvider) FetchOrderPaymentsForAccount(_ context.Context, _ string, id string) ([]provider.Payment, error) {
	return p.payments[id], nil
}

type fakeRecoveryStore struct {
	recovered []string
	completed []string
}

func (s *fakeRecoveryStore) PersistRecoveredPayment(_ context.Context, candidate Candidate, payment provider.Payment) (bool, error) {
	s.recovered = append(s.recovered, candidate.IntentID+":"+payment.ID)
	return false, nil
}

func (s *fakeRecoveryStore) CompletePaymentRecovery(_ context.Context, orderID string) error {
	s.completed = append(s.completed, orderID)
	return nil
}

func TestRunnerExpiresAndQueuesSafely(t *testing.T) {
	local := reconciliationNow
	expired := candidate()
	expired.IntentID = "expired-intent"
	expired.ProviderOrderID = "order-expired"
	expired.ExpiresAt = local.Add(-time.Second)
	paid := candidate()
	paid.IntentID = "paid-intent"
	paid.ProviderOrderID = "order-paid"
	paidOrder := order("paid", 5000, 0)
	paidOrder.ID = paid.ProviderOrderID
	expiredOrder := order("created", 0, 5000)
	expiredOrder.ID = expired.ProviderOrderID
	store := &fakeStore{candidates: []Candidate{expired, paid}}
	runner := Runner{
		Store: store,
		Provider: fakeProvider{orders: map[string]provider.Order{
			expired.ProviderOrderID: expiredOrder,
			paid.ProviderOrderID:    paidOrder,
		}},
		Now: func() time.Time { return local },
	}
	summary, err := runner.RunOnce(context.Background(), 20)
	if err != nil || summary.Expired != 1 || summary.RecoveryQueued != 1 || len(store.expired) != 1 || len(store.recovery) != 1 {
		t.Fatalf("unexpected reconciliation result: summary=%+v err=%v store=%+v", summary, err, store)
	}
}

func TestRunnerReturnsRetryableResultWithoutMutatingOnProviderFailure(t *testing.T) {
	store := &fakeStore{candidates: []Candidate{candidate()}}
	runner := Runner{Store: store, Provider: fakeProvider{err: errors.New("provider timeout")}, Now: func() time.Time { return reconciliationNow }}
	summary, err := runner.RunOnce(context.Background(), 20)
	if !errors.Is(err, ErrPartialRun) || summary.Retryable != 1 || len(store.expired) != 0 || len(store.recovery) != 0 {
		t.Fatalf("expected retryable no-mutation result: summary=%+v err=%v store=%+v", summary, err, store)
	}
}

func TestRunnerFetchesAndPersistsMatchingPaymentLevelEvidence(t *testing.T) {
	paid := candidate()
	paid.ProviderOrderID = "order-paid"
	paidOrder := order("paid", paid.AmountPaise, 0)
	paidOrder.ID = paid.ProviderOrderID
	store := &fakeStore{candidates: []Candidate{paid}}
	recovery := &fakeRecoveryStore{}
	runner := Runner{
		Store:            store,
		Provider:         fakeProvider{orders: map[string]provider.Order{paid.ProviderOrderID: paidOrder}},
		RecoveryProvider: fakeRecoveryProvider{payments: map[string][]provider.Payment{paid.ProviderOrderID: {{Entity: "payment", ID: "pay_recovered", AmountPaise: paid.AmountPaise, Currency: paid.Currency, Status: "captured", OrderID: paid.ProviderOrderID}}}},
		RecoveryStore:    recovery,
		Now:              func() time.Time { return reconciliationNow },
	}
	summary, err := runner.RunOnce(context.Background(), 20)
	if err != nil || summary.Recovered != 1 || len(recovery.recovered) != 1 || len(recovery.completed) != 1 {
		t.Fatalf("unexpected recovery result: summary=%+v err=%v store=%+v", summary, err, recovery)
	}
}
