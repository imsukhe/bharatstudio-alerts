package subscription

import (
	"context"
	"errors"
	"testing"

	"github.com/bharatstudio/bharatstudio-alerts/services/payment-webhook-go/internal/provider"
)

type fakeLifecycleStore struct {
	ref            ActiveSubscriptionRef
	hasRef         bool
	recordCalls    int
	completeCalls  int
	lastCompleteID string
	lastStatus     string
	lastResponse   string
	replay         bool
	recordErr      error
	completeErr    error
}

func (s *fakeLifecycleStore) GetActiveSubscriptionRef(_ context.Context, _ string) (ActiveSubscriptionRef, bool, error) {
	return s.ref, s.hasRef, nil
}

func (s *fakeLifecycleStore) RecordLifecycleRequest(_ context.Context, id, _, _, _, _, providerSubscriptionID, _, _ string) (LifecycleRequest, error) {
	s.recordCalls++
	if s.recordErr != nil {
		return LifecycleRequest{}, s.recordErr
	}
	if providerSubscriptionID == "" {
		return LifecycleRequest{}, errors.New("missing provider subscription id")
	}
	return LifecycleRequest{ID: id, Status: "requested", Replay: s.replay}, nil
}

func (s *fakeLifecycleStore) CompleteLifecycleRequest(_ context.Context, id, status, providerResponseStatus string) error {
	s.completeCalls++
	s.lastCompleteID, s.lastStatus, s.lastResponse = id, status, providerResponseStatus
	return s.completeErr
}

type fakeCanceller struct {
	calls  int
	result provider.Subscription
	err    error
}

func (c *fakeCanceller) CancelSubscription(_ context.Context, _ provider.CancelSubscriptionRequest) (provider.Subscription, error) {
	c.calls++
	return c.result, c.err
}

type fakeUpdater struct {
	calls   int
	lastReq provider.UpdateSubscriptionPlanRequest
	result  provider.Subscription
	err     error
}

func (u *fakeUpdater) UpdateSubscriptionPlan(_ context.Context, request provider.UpdateSubscriptionPlanRequest) (provider.Subscription, error) {
	u.calls++
	u.lastReq = request
	return u.result, u.err
}

func testLifecycleCatalog() MapCatalog {
	return MapCatalog{
		"test:creator:monthly": {ProviderAccountScope: "platform", ProviderAccountRef: "acct_platform", ProviderPlanID: "plan_creator_monthly", Tier: "creator", BillingInterval: "monthly", PricePaise: 39900, TotalCount: 12, Quantity: 1, CustomerNotify: true},
		"test:studio:monthly":  {ProviderAccountScope: "platform", ProviderAccountRef: "acct_platform", ProviderPlanID: "plan_studio_monthly", Tier: "studio", BillingInterval: "monthly", PricePaise: 49900, TotalCount: 12, Quantity: 1, CustomerNotify: true},
		"test:pro:monthly":     {ProviderAccountScope: "platform", ProviderAccountRef: "acct_platform", ProviderPlanID: "plan_pro_monthly", Tier: "pro", BillingInterval: "monthly", PricePaise: 19900, TotalCount: 12, Quantity: 1, CustomerNotify: true},
	}
}

func testLifecycleService(store *fakeLifecycleStore, canceller *fakeCanceller, updater *fakeUpdater) LifecycleService {
	service := NewLifecycleService(store, canceller, updater, testLifecycleCatalog())
	service.newID = func() (string, error) { return "00000000-0000-4000-8000-000000000601", nil }
	return service
}

func TestCancelResolvesRefAndConfirms(t *testing.T) {
	store := &fakeLifecycleStore{hasRef: true, ref: ActiveSubscriptionRef{ProviderAccountRef: "acct_platform", SubscriptionID: "sub_1", Tier: "creator", BillingInterval: "monthly", Status: "active"}}
	canceller := &fakeCanceller{result: provider.Subscription{Entity: "subscription", ID: "sub_1", Status: "active"}}
	result, err := testLifecycleService(store, canceller, nil).Cancel(context.Background(), CancelRequest{
		ChannelID: "channel-1", UserID: "user-1", Environment: "test", IdempotencyKey: "cancel-idempotency-001",
	})
	if err != nil {
		t.Fatalf("Cancel() error = %v", err)
	}
	if result.Status != "provider_confirmed" || canceller.calls != 1 || store.recordCalls != 1 || store.completeCalls != 1 {
		t.Fatalf("unexpected cancel result=%#v cancellerCalls=%d recordCalls=%d completeCalls=%d", result, canceller.calls, store.recordCalls, store.completeCalls)
	}
	if store.lastStatus != "provider_confirmed" || store.lastResponse != "" {
		t.Fatalf("unexpected completion status=%q response=%q", store.lastStatus, store.lastResponse)
	}
}

func TestCancelWithoutActiveSubscriptionFails(t *testing.T) {
	store := &fakeLifecycleStore{hasRef: false}
	canceller := &fakeCanceller{}
	_, err := testLifecycleService(store, canceller, nil).Cancel(context.Background(), CancelRequest{
		ChannelID: "channel-1", UserID: "user-1", Environment: "test", IdempotencyKey: "cancel-idempotency-002",
	})
	if !errors.Is(err, ErrNoActiveSubscription) || canceller.calls != 0 || store.recordCalls != 0 {
		t.Fatalf("expected ErrNoActiveSubscription without provider/store calls, got err=%v cancellerCalls=%d recordCalls=%d", err, canceller.calls, store.recordCalls)
	}
}

func TestCancelReplayDoesNotCallProviderAgain(t *testing.T) {
	store := &fakeLifecycleStore{hasRef: true, ref: ActiveSubscriptionRef{ProviderAccountRef: "acct_platform", SubscriptionID: "sub_1", Tier: "creator", BillingInterval: "monthly", Status: "active"}, replay: true}
	canceller := &fakeCanceller{result: provider.Subscription{Entity: "subscription", ID: "sub_1", Status: "active"}}
	result, err := testLifecycleService(store, canceller, nil).Cancel(context.Background(), CancelRequest{
		ChannelID: "channel-1", UserID: "user-1", Environment: "test", IdempotencyKey: "cancel-idempotency-003",
	})
	if err != nil || !result.Replay || canceller.calls != 0 || store.completeCalls != 0 {
		t.Fatalf("replay should skip provider call: result=%#v err=%v cancellerCalls=%d completeCalls=%d", result, err, canceller.calls, store.completeCalls)
	}
}

func TestCancelProviderFailureMarksRequestFailed(t *testing.T) {
	store := &fakeLifecycleStore{hasRef: true, ref: ActiveSubscriptionRef{ProviderAccountRef: "acct_platform", SubscriptionID: "sub_1", Tier: "creator", BillingInterval: "monthly", Status: "active"}}
	providerErr := &provider.ProviderError{Operation: "POST /v1/subscriptions/sub_1/cancel", StatusCode: 502, Retryable: true}
	canceller := &fakeCanceller{err: providerErr}
	_, err := testLifecycleService(store, canceller, nil).Cancel(context.Background(), CancelRequest{
		ChannelID: "channel-1", UserID: "user-1", Environment: "test", IdempotencyKey: "cancel-idempotency-004",
	})
	if !errors.Is(err, providerErr) {
		t.Fatalf("expected provider error to propagate, got %v", err)
	}
	if store.completeCalls != 1 || store.lastStatus != "provider_failed" || store.lastResponse == "" {
		t.Fatalf("expected provider_failed completion, got calls=%d status=%q response=%q", store.completeCalls, store.lastStatus, store.lastResponse)
	}
}

func TestChangePlanUpgradeAppliesNow(t *testing.T) {
	store := &fakeLifecycleStore{hasRef: true, ref: ActiveSubscriptionRef{ProviderAccountRef: "acct_platform", SubscriptionID: "sub_1", Tier: "pro", BillingInterval: "monthly", Status: "active"}}
	updater := &fakeUpdater{result: provider.Subscription{Entity: "subscription", ID: "sub_1", Status: "active"}}
	result, err := testLifecycleService(store, nil, updater).ChangePlan(context.Background(), ChangePlanRequest{
		ChannelID: "channel-1", UserID: "user-1", Environment: "test", IdempotencyKey: "change-idempotency-001",
		TargetTier: "studio", BillingInterval: "monthly",
	}, false)
	if err != nil {
		t.Fatalf("ChangePlan() upgrade error = %v", err)
	}
	if result.Status != "provider_confirmed" || updater.calls != 1 {
		t.Fatalf("unexpected upgrade result=%#v updaterCalls=%d", result, updater.calls)
	}
	if updater.lastReq.ScheduleChangeAtCycleEnd || updater.lastReq.PlanID != "plan_studio_monthly" {
		t.Fatalf("upgrade must schedule now with the target plan id, got %#v", updater.lastReq)
	}
}

func TestChangePlanDowngradeSchedulesAtCycleEnd(t *testing.T) {
	store := &fakeLifecycleStore{hasRef: true, ref: ActiveSubscriptionRef{ProviderAccountRef: "acct_platform", SubscriptionID: "sub_1", Tier: "studio", BillingInterval: "monthly", Status: "active"}}
	updater := &fakeUpdater{result: provider.Subscription{Entity: "subscription", ID: "sub_1", Status: "active"}}
	_, err := testLifecycleService(store, nil, updater).ChangePlan(context.Background(), ChangePlanRequest{
		ChannelID: "channel-1", UserID: "user-1", Environment: "test", IdempotencyKey: "change-idempotency-002",
		TargetTier: "pro", BillingInterval: "monthly",
	}, true)
	if err != nil {
		t.Fatalf("ChangePlan() downgrade error = %v", err)
	}
	if !updater.lastReq.ScheduleChangeAtCycleEnd || updater.lastReq.PlanID != "plan_pro_monthly" {
		t.Fatalf("downgrade must schedule at cycle end with the target plan id, got %#v", updater.lastReq)
	}
}

func TestChangePlanUnknownTargetIsNotConfigured(t *testing.T) {
	store := &fakeLifecycleStore{hasRef: true, ref: ActiveSubscriptionRef{ProviderAccountRef: "acct_platform", SubscriptionID: "sub_1", Tier: "pro", BillingInterval: "monthly", Status: "active"}}
	updater := &fakeUpdater{}
	_, err := testLifecycleService(store, nil, updater).ChangePlan(context.Background(), ChangePlanRequest{
		ChannelID: "channel-1", UserID: "user-1", Environment: "test", IdempotencyKey: "change-idempotency-003",
		TargetTier: "creator", BillingInterval: "annual",
	}, false)
	if !errors.Is(err, ErrNotConfigured) || updater.calls != 0 {
		t.Fatalf("expected ErrNotConfigured for unresolvable plan without a provider call, got err=%v updaterCalls=%d", err, updater.calls)
	}
}

func TestReactivateReusesCurrentPlanScheduledNow(t *testing.T) {
	store := &fakeLifecycleStore{hasRef: true, ref: ActiveSubscriptionRef{ProviderAccountRef: "acct_platform", SubscriptionID: "sub_1", Tier: "creator", BillingInterval: "monthly", Status: "past_due"}}
	updater := &fakeUpdater{result: provider.Subscription{Entity: "subscription", ID: "sub_1", Status: "active"}}
	result, err := testLifecycleService(store, nil, updater).Reactivate(context.Background(), ReactivateRequest{
		ChannelID: "channel-1", UserID: "user-1", Environment: "test", IdempotencyKey: "reactivate-idempotency-001",
	})
	if err != nil {
		t.Fatalf("Reactivate() error = %v", err)
	}
	if result.Status != "provider_confirmed" || updater.lastReq.ScheduleChangeAtCycleEnd || updater.lastReq.PlanID != "plan_creator_monthly" {
		t.Fatalf("reactivate must resubmit current plan now, got result=%#v req=%#v", result, updater.lastReq)
	}
}
