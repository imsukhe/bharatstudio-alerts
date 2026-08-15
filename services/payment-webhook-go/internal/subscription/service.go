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

func randomUUID() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", value[0:4], value[4:6], value[6:8], value[8:10], value[10:16]), nil
}
