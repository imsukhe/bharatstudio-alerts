package subscription

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"time"

	"github.com/bharatstudio/bharatstudio-alerts/services/payment-webhook-go/internal/provider"
)

var (
	ErrInvalidRequest       = errors.New("invalid subscription request")
	ErrInProgress           = errors.New("subscription creation already in progress")
	ErrRecoveryRequired     = errors.New("subscription creation requires recovery")
	ErrNotConfigured        = errors.New("subscription billing is not configured")
	ErrPersistence          = errors.New("subscription persistence failed")
	ErrProviderPlanMismatch = errors.New("provider subscription plan mismatch")
)

type Request struct {
	UserID          string
	ChannelID       string
	Environment     string
	IdempotencyKey  string
	Tier            string
	BillingInterval string
}

type Plan struct {
	ProviderAccountScope string
	ProviderAccountRef   string
	ProviderPlanID       string
	Tier                 string
	BillingInterval      string
	PricePaise           int64
	TotalCount           int
	Quantity             int
	CustomerNotify       bool
}

type Intent struct {
	ID                     string
	ChannelID              string
	UserID                 string
	Environment            string
	ProviderAccountScope   string
	ProviderAccountRef     string
	ProviderPlanID         string
	Tier                   string
	BillingInterval        string
	PricePaise             int64
	ProviderSubscriptionID string
	ProviderStatus         string
	CheckoutURL            string
	Status                 string
}

type IntentStore interface {
	CreateSubscriptionIntent(context.Context, Request, Plan, string) (Intent, error)
	ClaimSubscriptionProviderCreation(context.Context, string, string, time.Time) (Intent, bool, error)
	AttachSubscriptionProvider(context.Context, string, string, provider.Subscription) (Intent, bool, error)
	LinkSubscriptionIntent(context.Context, string) (Intent, error)
	MarkSubscriptionRecovery(context.Context, string, string) (Intent, error)
}

type ProviderClient interface {
	CreateSubscription(context.Context, provider.CreateSubscriptionRequest) (provider.Subscription, error)
}

type PlanCatalog interface {
	Resolve(environment, tier, billingInterval string) (Plan, bool)
}

type MapCatalog map[string]Plan

func (catalog MapCatalog) Resolve(environment, tier, billingInterval string) (Plan, bool) {
	plan, ok := catalog[environment+":"+tier+":"+billingInterval]
	return plan, ok
}

type Service struct {
	store    IntentStore
	provider ProviderClient
	catalog  PlanCatalog
	now      func() time.Time
	token    func() (string, error)
	claimFor time.Duration
	newID    func() (string, error)
}

func NewService(store IntentStore, client ProviderClient, catalog PlanCatalog) Service {
	return Service{
		store: store, provider: client, catalog: catalog,
		now: time.Now, token: randomUUID, claimFor: 20 * time.Second, newID: randomUUID,
	}
}

func (s Service) Create(ctx context.Context, request Request) (Intent, error) {
	if s.store == nil || s.provider == nil || s.catalog == nil {
		return Intent{}, ErrNotConfigured
	}
	if request.UserID == "" || request.ChannelID == "" || request.Environment == "" || request.IdempotencyKey == "" || request.Tier == "" || request.BillingInterval == "" {
		return Intent{}, ErrInvalidRequest
	}
	plan, ok := s.catalog.Resolve(request.Environment, request.Tier, request.BillingInterval)
	if !ok || plan.ProviderAccountScope == "" || plan.ProviderAccountRef == "" || plan.ProviderPlanID == "" || plan.Tier != request.Tier || plan.BillingInterval != request.BillingInterval || plan.PricePaise <= 0 || plan.TotalCount <= 0 || plan.Quantity <= 0 {
		return Intent{}, ErrNotConfigured
	}

	intentID, err := s.newID()
	if err != nil {
		return Intent{}, ErrPersistence
	}
	intent, err := s.store.CreateSubscriptionIntent(ctx, request, plan, intentID)
	if err != nil {
		return Intent{}, err
	}
	if intent.Status == "linked" {
		return intent, nil
	}
	if intent.ProviderSubscriptionID != "" {
		linked, linkErr := s.store.LinkSubscriptionIntent(ctx, intent.ID)
		if linkErr != nil {
			_, _ = s.store.MarkSubscriptionRecovery(ctx, intent.ID, "link_retry_failed")
			return intent, ErrRecoveryRequired
		}
		return linked, nil
	}
	if intent.Status != "requested" {
		return intent, ErrInProgress
	}

	claimToken, err := s.token()
	if err != nil {
		return Intent{}, ErrPersistence
	}
	claimed, acquired, err := s.store.ClaimSubscriptionProviderCreation(ctx, intent.ID, claimToken, s.now().Add(s.claimFor))
	if err != nil {
		return Intent{}, err
	}
	if !acquired || claimed.Status != "provider_pending" || claimed.ProviderSubscriptionID != "" {
		return claimed, ErrInProgress
	}

	created, err := s.provider.CreateSubscription(ctx, provider.CreateSubscriptionRequest{
		ProviderAccountRef: plan.ProviderAccountRef,
		AccountScope:       plan.ProviderAccountScope,
		PlanID:             plan.ProviderPlanID,
		TotalCount:         plan.TotalCount,
		Quantity:           plan.Quantity,
		CustomerNotify:     plan.CustomerNotify,
		Notes:              map[string]string{"bsa_subscription_intent_id": intent.ID, "bsa_channel_id": intent.ChannelID},
	})
	if err != nil {
		_, _ = s.store.MarkSubscriptionRecovery(ctx, intent.ID, "provider_create_failed")
		return intent, ErrRecoveryRequired
	}
	if created.PlanID != plan.ProviderPlanID || created.ID == "" {
		_, _ = s.store.MarkSubscriptionRecovery(ctx, intent.ID, "provider_plan_mismatch")
		return intent, ErrProviderPlanMismatch
	}

	attached, attachedOK, err := s.store.AttachSubscriptionProvider(ctx, intent.ID, claimToken, created)
	if err != nil || !attachedOK {
		_, _ = s.store.MarkSubscriptionRecovery(ctx, intent.ID, "provider_attach_failed")
		return intent, ErrRecoveryRequired
	}
	linked, err := s.store.LinkSubscriptionIntent(ctx, attached.ID)
	if err != nil {
		_, _ = s.store.MarkSubscriptionRecovery(ctx, attached.ID, "link_registration_failed")
		return attached, ErrRecoveryRequired
	}
	return linked, nil
}

// --- Lifecycle (cancel / change plan / reactivate) ---------------------
//
// Unlike Create, these do not themselves change channel_subscriptions
// state — that remains exclusively the job of the already-implemented,
// already-tested verified-webhook path (apply_channel_subscription_state).
// These methods only: (1) resolve which provider subscription the request
// targets, (2) record the request idempotently, (3) call Razorpay, (4) mark
// the request's provider-call outcome. The confirming state transition
// arrives later via Razorpay's own subscription.cancelled/updated webhook.

var (
	ErrNoActiveSubscription = errors.New("no active subscription for channel")
	ErrLifecyclePersistence = errors.New("subscription lifecycle request could not be recorded")
)

type ActiveSubscriptionRef struct {
	ProviderAccountRef string
	SubscriptionID     string
	Tier               string
	BillingInterval    string
	Status             string
	AutoRenew          bool
}

type LifecycleRequest struct {
	ID                     string
	Status                 string
	ProviderResponseStatus string
	Replay                 bool
}

// All three lifecycle requests below operate exclusively on channel_subscriptions
// (BharatStudio's own platform Pro/Creator/Studio billing) — never on a
// creator's connected payout account — so, like the plan catalog itself
// (see catalog.go), the provider account scope is always "platform".
const platformAccountScope = "platform"

type CancelRequest struct {
	ChannelID      string
	UserID         string
	Environment    string
	IdempotencyKey string
}

type ChangePlanRequest struct {
	ChannelID       string
	UserID          string
	Environment     string
	IdempotencyKey  string
	TargetTier      string
	BillingInterval string
}

type ReactivateRequest struct {
	ChannelID      string
	UserID         string
	Environment    string
	IdempotencyKey string
}

type LifecycleStore interface {
	GetActiveSubscriptionRef(ctx context.Context, channelID string) (ActiveSubscriptionRef, bool, error)
	RecordLifecycleRequest(ctx context.Context, id, channelID, userID, action, idempotencyKey, providerSubscriptionID, targetTier, targetBillingInterval string) (LifecycleRequest, error)
	CompleteLifecycleRequest(ctx context.Context, id, status, providerResponseStatus string) error
}

type CancelProviderClient interface {
	CancelSubscription(context.Context, provider.CancelSubscriptionRequest) (provider.Subscription, error)
}

type UpdatePlanProviderClient interface {
	UpdateSubscriptionPlan(context.Context, provider.UpdateSubscriptionPlanRequest) (provider.Subscription, error)
}

type LifecycleService struct {
	store     LifecycleStore
	canceller CancelProviderClient
	updater   UpdatePlanProviderClient
	catalog   PlanCatalog
	newID     func() (string, error)
}

func NewLifecycleService(store LifecycleStore, canceller CancelProviderClient, updater UpdatePlanProviderClient, catalog PlanCatalog) LifecycleService {
	return LifecycleService{store: store, canceller: canceller, updater: updater, catalog: catalog, newID: randomUUID}
}

func (s LifecycleService) resolveActive(ctx context.Context, channelID string) (ActiveSubscriptionRef, error) {
	ref, ok, err := s.store.GetActiveSubscriptionRef(ctx, channelID)
	if err != nil {
		return ActiveSubscriptionRef{}, err
	}
	if !ok {
		return ActiveSubscriptionRef{}, ErrNoActiveSubscription
	}
	return ref, nil
}

// Cancel requests Razorpay stop future charges, keeping access through the
// already-paid period (cancel_at_cycle_end=true) — matching the launch
// authority's self-serve-cancellation requirement.
func (s LifecycleService) Cancel(ctx context.Context, request CancelRequest) (LifecycleRequest, error) {
	if s.store == nil || s.canceller == nil {
		return LifecycleRequest{}, ErrNotConfigured
	}
	if request.ChannelID == "" || request.UserID == "" || request.IdempotencyKey == "" {
		return LifecycleRequest{}, ErrInvalidRequest
	}
	ref, err := s.resolveActive(ctx, request.ChannelID)
	if err != nil {
		return LifecycleRequest{}, err
	}
	id, err := s.newID()
	if err != nil {
		return LifecycleRequest{}, ErrLifecyclePersistence
	}
	recorded, err := s.store.RecordLifecycleRequest(ctx, id, request.ChannelID, request.UserID, "cancel", request.IdempotencyKey, ref.SubscriptionID, "", "")
	if err != nil {
		return LifecycleRequest{}, err
	}
	if recorded.Replay {
		return recorded, nil
	}
	_, providerErr := s.canceller.CancelSubscription(ctx, provider.CancelSubscriptionRequest{
		ProviderAccountRef: ref.ProviderAccountRef, AccountScope: platformAccountScope,
		SubscriptionID: ref.SubscriptionID, CancelAtCycleEnd: true,
	})
	status, responseStatus := completionStatus(providerErr)
	_ = s.store.CompleteLifecycleRequest(ctx, recorded.ID, status, responseStatus)
	if providerErr != nil {
		return LifecycleRequest{}, providerErr
	}
	recorded.Status = status
	return recorded, nil
}

// ChangePlan drives both upgrade (immediate — "now") and downgrade
// (scheduled — "cycle_end", so a creator never pays more mid-cycle than the
// plan they were on when the cycle started). The Plan resolution reuses the
// exact same approved catalog Create() uses, so a caller can never request
// an unapproved plan/price.
func (s LifecycleService) ChangePlan(ctx context.Context, request ChangePlanRequest, scheduleAtCycleEnd bool) (LifecycleRequest, error) {
	if s.store == nil || s.updater == nil || s.catalog == nil {
		return LifecycleRequest{}, ErrNotConfigured
	}
	if request.ChannelID == "" || request.UserID == "" || request.IdempotencyKey == "" || request.TargetTier == "" || request.BillingInterval == "" {
		return LifecycleRequest{}, ErrInvalidRequest
	}
	plan, ok := s.catalog.Resolve(request.Environment, request.TargetTier, request.BillingInterval)
	if !ok || plan.ProviderPlanID == "" {
		return LifecycleRequest{}, ErrNotConfigured
	}
	ref, err := s.resolveActive(ctx, request.ChannelID)
	if err != nil {
		return LifecycleRequest{}, err
	}
	id, err := s.newID()
	if err != nil {
		return LifecycleRequest{}, ErrLifecyclePersistence
	}
	recorded, err := s.store.RecordLifecycleRequest(ctx, id, request.ChannelID, request.UserID, "change_plan", request.IdempotencyKey, ref.SubscriptionID, request.TargetTier, request.BillingInterval)
	if err != nil {
		return LifecycleRequest{}, err
	}
	if recorded.Replay {
		return recorded, nil
	}
	_, providerErr := s.updater.UpdateSubscriptionPlan(ctx, provider.UpdateSubscriptionPlanRequest{
		ProviderAccountRef: ref.ProviderAccountRef, AccountScope: platformAccountScope,
		SubscriptionID: ref.SubscriptionID, PlanID: plan.ProviderPlanID, ScheduleChangeAtCycleEnd: scheduleAtCycleEnd,
	})
	status, responseStatus := completionStatus(providerErr)
	_ = s.store.CompleteLifecycleRequest(ctx, recorded.ID, status, responseStatus)
	if providerErr != nil {
		return LifecycleRequest{}, providerErr
	}
	recorded.Status = status
	return recorded, nil
}

// Reactivate clears a pending cycle-end cancellation by re-submitting the
// subscription's current plan with schedule_change_at="now". This specific
// Razorpay behaviour (does a plan-update PATCH clear cancel_at_cycle_end?)
// is not yet verified against a live sandbox — flagged as an external gate
// alongside the rest of L04's provider-behaviour list, not assumed here.
func (s LifecycleService) Reactivate(ctx context.Context, request ReactivateRequest) (LifecycleRequest, error) {
	if s.store == nil || s.updater == nil {
		return LifecycleRequest{}, ErrNotConfigured
	}
	if request.ChannelID == "" || request.UserID == "" || request.IdempotencyKey == "" {
		return LifecycleRequest{}, ErrInvalidRequest
	}
	ref, err := s.resolveActive(ctx, request.ChannelID)
	if err != nil {
		return LifecycleRequest{}, err
	}
	plan, ok := s.catalog.Resolve(request.Environment, ref.Tier, ref.BillingInterval)
	if !ok || plan.ProviderPlanID == "" {
		return LifecycleRequest{}, ErrNotConfigured
	}
	id, err := s.newID()
	if err != nil {
		return LifecycleRequest{}, ErrLifecyclePersistence
	}
	recorded, err := s.store.RecordLifecycleRequest(ctx, id, request.ChannelID, request.UserID, "reactivate", request.IdempotencyKey, ref.SubscriptionID, "", "")
	if err != nil {
		return LifecycleRequest{}, err
	}
	if recorded.Replay {
		return recorded, nil
	}
	_, providerErr := s.updater.UpdateSubscriptionPlan(ctx, provider.UpdateSubscriptionPlanRequest{
		ProviderAccountRef: ref.ProviderAccountRef, AccountScope: platformAccountScope,
		SubscriptionID: ref.SubscriptionID, PlanID: plan.ProviderPlanID, ScheduleChangeAtCycleEnd: false,
	})
	status, responseStatus := completionStatus(providerErr)
	_ = s.store.CompleteLifecycleRequest(ctx, recorded.ID, status, responseStatus)
	if providerErr != nil {
		return LifecycleRequest{}, providerErr
	}
	recorded.Status = status
	return recorded, nil
}

func completionStatus(err error) (status, responseStatus string) {
	if err != nil {
		return "provider_failed", err.Error()
	}
	return "provider_confirmed", ""
}

func randomUUID() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", value[0:4], value[4:6], value[6:8], value[8:10], value[10:16]), nil
}
