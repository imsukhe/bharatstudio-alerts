package checkout

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/bharatstudio/bharatstudio-alerts/services/payment-webhook-go/internal/provider"
)

type fakeStore struct {
	intent      Intent
	acquired    bool
	attachOK    bool
	claimCalls  int
	attachCalls int
}

func (s *fakeStore) CreateIntent(context.Context, IntentRequest) (Intent, error) {
	return s.intent, nil
}

func (s *fakeStore) ClaimProviderCreation(_ context.Context, _, _ string, _ time.Time) (Intent, bool, error) {
	s.claimCalls++
	return s.intent, s.acquired, nil
}

func (s *fakeStore) AttachProviderOrder(_ context.Context, _, _, providerOrderID string, _ time.Time) (Intent, bool, error) {
	s.attachCalls++
	s.intent.ProviderOrderID = providerOrderID
	s.intent.Status = "provider_created"
	return s.intent, s.attachOK, nil
}

type fakeOrders struct {
	order provider.Order
	err   error
	calls int
	last  provider.CreateOrderRequest
}

func (p *fakeOrders) CreateOrder(_ context.Context, request provider.CreateOrderRequest) (provider.Order, error) {
	p.calls++
	p.last = request
	return p.order, p.err
}

func serviceFor(store *fakeStore, orders *fakeOrders) Service {
	service := NewService(store, orders)
	service.now = func() time.Time { return time.Unix(1700000000, 0) }
	service.token = func() (string, error) { return "claim-token", nil }
	return service
}

func validRequest() IntentRequest {
	return IntentRequest{
		IntentID:       "intent-1",
		ChannelID:      "channel-1",
		Environment:    "test",
		IdempotencyKey: "idempotency-1",
		Receipt:        "receipt-1",
		AmountPaise:    5000,
		Currency:       "INR",
		DisplayName:    "Synthetic Donor",
		Message:        "Thanks!",
		AlertConsent:   true,
		ExpiresAt:      time.Unix(1700000900, 0),
	}
}

func TestCreateOrderClaimsBeforeProviderAndAttachesAfterMatch(t *testing.T) {
	store := &fakeStore{intent: Intent{ID: "intent-1", ConnectedAccountRef: "acc_test", AmountPaise: 5000, Currency: "INR", Receipt: "receipt-1", Status: "provider_pending"}, acquired: true, attachOK: true}
	orders := &fakeOrders{order: provider.Order{ID: "order-1", AmountPaise: 5000, Currency: "INR", Receipt: "receipt-1"}}
	result, err := serviceFor(store, orders).CreateOrder(context.Background(), validRequest())
	if err != nil || result.ProviderOrderID != "order-1" || store.claimCalls != 1 || store.attachCalls != 1 || orders.calls != 1 {
		t.Fatalf("result=%#v err=%v claims=%d attaches=%d provider=%d", result, err, store.claimCalls, store.attachCalls, orders.calls)
	}
	if orders.last.ConnectedAccountRef != "acc_test" || orders.last.Notes["bsa_intent_id"] != "intent-1" || len(orders.last.Notes) != 1 {
		t.Fatalf("provider notes=%#v", orders.last.Notes)
	}
}

func TestCreateOrderDoesNotCallProviderWhenAnotherReplicaOwnsClaim(t *testing.T) {
	store := &fakeStore{intent: Intent{ID: "intent-1", AmountPaise: 5000, Currency: "INR", Receipt: "receipt-1", Status: "provider_pending"}, acquired: false}
	orders := &fakeOrders{}
	_, err := serviceFor(store, orders).CreateOrder(context.Background(), validRequest())
	if !errors.Is(err, ErrOrderCreationInProgress) || orders.calls != 0 {
		t.Fatalf("err=%v provider_calls=%d", err, orders.calls)
	}
}

func TestCreateOrderReturnsExistingProviderOrderWithoutCallingProvider(t *testing.T) {
	store := &fakeStore{intent: Intent{ID: "intent-1", AmountPaise: 5000, Currency: "INR", Receipt: "receipt-1", ProviderOrderID: "order-existing", Status: "provider_created"}}
	orders := &fakeOrders{}
	result, err := serviceFor(store, orders).CreateOrder(context.Background(), validRequest())
	if err != nil || result.ProviderOrderID != "order-existing" || orders.calls != 0 {
		t.Fatalf("result=%#v err=%v provider_calls=%d", result, err, orders.calls)
	}
}

func TestCreateOrderRejectsProviderMismatchAndPersistenceFailure(t *testing.T) {
	store := &fakeStore{intent: Intent{ID: "intent-1", ConnectedAccountRef: "acc_test", AmountPaise: 5000, Currency: "INR", Receipt: "receipt-1", Status: "provider_pending"}, acquired: true, attachOK: true}
	orders := &fakeOrders{order: provider.Order{ID: "order-1", AmountPaise: 6000, Currency: "INR", Receipt: "receipt-1"}}
	if _, err := serviceFor(store, orders).CreateOrder(context.Background(), validRequest()); !errors.Is(err, ErrProviderOrderMismatch) {
		t.Fatalf("mismatch error = %v", err)
	}

	orders.order = provider.Order{ID: "order-1", AmountPaise: 5000, Currency: "INR", Receipt: "receipt-1"}
	store.attachOK = false
	if _, err := serviceFor(store, orders).CreateOrder(context.Background(), validRequest()); !errors.Is(err, ErrOrderPersistence) {
		t.Fatalf("attach error = %v", err)
	}
}
