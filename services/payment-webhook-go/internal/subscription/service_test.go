package subscription

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/bharatstudio/bharatstudio-alerts/services/payment-webhook-go/internal/provider"
)

type fakeStore struct {
	intent      Intent
	createCalls int
	claimCalls  int
	attachCalls int
	linkCalls   int
	markCalls   int
	linkErr     error
	createErr   error
	providerErr error
}

func (s *fakeStore) CreateSubscriptionIntent(_ context.Context, request Request, plan Plan, intentID string) (Intent, error) {
	s.createCalls++
	if s.createErr != nil {
		return Intent{}, s.createErr
	}
	if s.intent.ID != "" {
		return s.intent, nil
	}
	s.intent = Intent{
		ID: intentID, ChannelID: request.ChannelID, UserID: request.UserID,
		Environment: request.Environment, ProviderAccountScope: plan.ProviderAccountScope,
		ProviderAccountRef: plan.ProviderAccountRef, ProviderPlanID: plan.ProviderPlanID,
		Tier: plan.Tier, BillingInterval: plan.BillingInterval, PricePaise: plan.PricePaise,
		Status: "requested",
	}
	return s.intent, nil
}

func (s *fakeStore) ClaimSubscriptionProviderCreation(_ context.Context, _ string, _ string, _ time.Time) (Intent, bool, error) {
	s.claimCalls++
	if s.intent.Status != "requested" {
		return s.intent, false, nil
	}
	s.intent.Status = "provider_pending"
	return s.intent, true, nil
}

func (s *fakeStore) AttachSubscriptionProvider(_ context.Context, _ string, _ string, created provider.Subscription) (Intent, bool, error) {
	s.attachCalls++
	s.intent.ProviderSubscriptionID = created.ID
	s.intent.ProviderStatus = created.Status
	s.intent.CheckoutURL = created.ShortURL
	s.intent.Status = "provider_created"
	return s.intent, true, nil
}

func (s *fakeStore) LinkSubscriptionIntent(_ context.Context, _ string) (Intent, error) {
	s.linkCalls++
	if s.linkErr != nil {
		return s.intent, s.linkErr
	}
	s.intent.Status = "linked"
	return s.intent, nil
}

func (s *fakeStore) MarkSubscriptionRecovery(_ context.Context, _ string, _ string) (Intent, error) {
	s.markCalls++
	if s.intent.ProviderSubscriptionID == "" {
		s.intent.Status = "recovery_required"
	} else {
		s.intent.Status = "provider_created"
	}
	return s.intent, nil
}

type fakeProvider struct {
	calls  int
	result provider.Subscription
	err    error
}

func (p *fakeProvider) CreateSubscription(_ context.Context, _ provider.CreateSubscriptionRequest) (provider.Subscription, error) {
	p.calls++
	return p.result, p.err
}

func testService(store *fakeStore, client *fakeProvider) Service {
	service := NewService(store, client, MapCatalog{
		"test:creator:monthly": {
			ProviderAccountScope: "platform", ProviderAccountRef: "acct_platform",
			ProviderPlanID: "plan_creator_monthly", Tier: "creator", BillingInterval: "monthly",
			PricePaise: 39900, TotalCount: 12, Quantity: 1, CustomerNotify: true,
		},
	})
	service.newID = func() (string, error) { return "00000000-0000-4000-8000-000000000501", nil }
	service.token = func() (string, error) { return "00000000-0000-4000-8000-000000000511", nil }
	return service
}

func testRequest() Request {
	return Request{UserID: "user-1", ChannelID: "channel-1", Environment: "test", IdempotencyKey: "subscription-idempotency-001", Tier: "creator", BillingInterval: "monthly"}
}

func TestCreateSubscriptionPersistsBeforeProviderAndLinks(t *testing.T) {
	store := &fakeStore{}
	client := &fakeProvider{result: provider.Subscription{Entity: "subscription", ID: "sub_1", PlanID: "plan_creator_monthly", Status: "created", ShortURL: "https://rzp.io/i/test"}}
	result, err := testService(store, client).Create(context.Background(), testRequest())
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if result.Status != "linked" || result.ProviderSubscriptionID != "sub_1" || client.calls != 1 || store.createCalls != 1 || store.claimCalls != 1 || store.attachCalls != 1 || store.linkCalls != 1 {
		t.Fatalf("unexpected orchestration result=%#v providerCalls=%d store=%+v", result, client.calls, store)
	}
}

func TestRepeatedLinkedIntentDoesNotCallProviderAgain(t *testing.T) {
	store := &fakeStore{intent: Intent{ID: "intent-1", Status: "linked", ProviderSubscriptionID: "sub_1"}}
	client := &fakeProvider{result: provider.Subscription{ID: "sub_2", PlanID: "plan_creator_monthly", Status: "created"}}
	result, err := testService(store, client).Create(context.Background(), testRequest())
	if err != nil || result.Status != "linked" || client.calls != 0 || store.claimCalls != 0 {
		t.Fatalf("repeated linked request result=%#v err=%v providerCalls=%d claimCalls=%d", result, err, client.calls, store.claimCalls)
	}
}

func TestProviderFailureDoesNotBlindlyRetry(t *testing.T) {
	store := &fakeStore{}
	client := &fakeProvider{err: errors.New("timeout after request")}
	service := testService(store, client)
	result, err := service.Create(context.Background(), testRequest())
	if !errors.Is(err, ErrRecoveryRequired) || result.Status != "requested" || store.markCalls != 1 || client.calls != 1 {
		t.Fatalf("first ambiguous result=%#v err=%v providerCalls=%d markCalls=%d", result, err, client.calls, store.markCalls)
	}
	_, err = service.Create(context.Background(), testRequest())
	if !errors.Is(err, ErrInProgress) || client.calls != 1 {
		t.Fatalf("retry should not call provider again: err=%v providerCalls=%d", err, client.calls)
	}
}

func TestExistingProviderIdentityRetriesLinkOnly(t *testing.T) {
	store := &fakeStore{intent: Intent{ID: "intent-1", Status: "provider_created", ProviderSubscriptionID: "sub_1", ProviderPlanID: "plan_creator_monthly", Tier: "creator", BillingInterval: "monthly", PricePaise: 39900}}
	client := &fakeProvider{}
	result, err := testService(store, client).Create(context.Background(), testRequest())
	if err != nil || result.Status != "linked" || store.linkCalls != 1 || client.calls != 0 {
		t.Fatalf("link repair result=%#v err=%v linkCalls=%d providerCalls=%d", result, err, store.linkCalls, client.calls)
	}
}

func TestLinkFailureLeavesRecoveryState(t *testing.T) {
	store := &fakeStore{linkErr: errors.New("database unavailable")}
	client := &fakeProvider{result: provider.Subscription{ID: "sub_1", PlanID: "plan_creator_monthly", Status: "created"}}
	result, err := testService(store, client).Create(context.Background(), testRequest())
	if !errors.Is(err, ErrRecoveryRequired) || result.Status != "provider_created" || store.markCalls != 1 {
		t.Fatalf("link failure result=%#v err=%v markCalls=%d", result, err, store.markCalls)
	}
}
