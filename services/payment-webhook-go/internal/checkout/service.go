package checkout

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"time"

	"github.com/bharatstudio/bharatstudio-alerts/services/payment-webhook-go/internal/provider"
)

var (
	ErrOrderCreationInProgress = errors.New("payment order creation already in progress")
	ErrProviderOrderMismatch   = errors.New("provider order did not match local intent")
	ErrMissingPaymentAccount   = errors.New("payment account attribution is missing")
	ErrOrderPersistence        = errors.New("payment order persistence failed")
)

type IntentRequest struct {
	IntentID       string
	ChannelID      string
	Environment    string
	IdempotencyKey string
	Receipt        string
	AmountPaise    int64
	Currency       string
	DisplayName    string
	Message        string
	AlertConsent   bool
	ExpiresAt      time.Time
	Notes          map[string]string
	TraceID        string
}

type Intent struct {
	ID                  string
	ConnectedAccountRef string
	AmountPaise         int64
	Currency            string
	Receipt             string
	ProviderOrderID     string
	DisplayName         string
	Message             string
	AlertConsent        bool
	Status              string
}

type IntentStore interface {
	CreateIntent(context.Context, IntentRequest) (Intent, error)
	ClaimProviderCreation(ctx context.Context, intentID string, claimToken string, claimUntil time.Time) (Intent, bool, error)
	AttachProviderOrder(ctx context.Context, intentID string, claimToken string, providerOrderID string, providerCreatedAt time.Time) (Intent, bool, error)
}

type OrdersClient interface {
	CreateOrder(context.Context, provider.CreateOrderRequest) (provider.Order, error)
}

type Service struct {
	store    IntentStore
	provider OrdersClient
	now      func() time.Time
	token    func() (string, error)
	claimFor time.Duration
}

func NewService(store IntentStore, orders OrdersClient) Service {
	return Service{
		store:    store,
		provider: orders,
		now:      time.Now,
		token:    randomClaimToken,
		claimFor: 20 * time.Second,
	}
}

func (s Service) CreateOrder(ctx context.Context, request IntentRequest) (Intent, error) {
	if s.store == nil || s.provider == nil {
		return Intent{}, ErrOrderPersistence
	}
	intent, err := s.store.CreateIntent(ctx, request)
	if err != nil {
		return Intent{}, err
	}
	if intent.ProviderOrderID != "" {
		return intent, nil
	}

	claimToken, err := s.token()
	if err != nil || claimToken == "" {
		return Intent{}, ErrOrderPersistence
	}
	now := s.now()
	claimed, acquired, err := s.store.ClaimProviderCreation(ctx, intent.ID, claimToken, now.Add(s.claimFor))
	if err != nil {
		return Intent{}, err
	}
	if !acquired {
		if claimed.ProviderOrderID != "" {
			return claimed, nil
		}
		return Intent{}, ErrOrderCreationInProgress
	}
	// The claim query only needs to return the lease fields. Preserve the
	// account selected by the authoritative intent lookup for this provider call.
	claimed.ConnectedAccountRef = intent.ConnectedAccountRef
	if claimed.ConnectedAccountRef == "" {
		return Intent{}, ErrMissingPaymentAccount
	}

	providerOrder, err := s.provider.CreateOrder(ctx, provider.CreateOrderRequest{
		AmountPaise:         intent.AmountPaise,
		Currency:            intent.Currency,
		Receipt:             intent.Receipt,
		ConnectedAccountRef: claimed.ConnectedAccountRef,
		// Provider metadata is derived from the authoritative local intent,
		// never copied from a retry's mutable request body.
		Notes: map[string]string{"bsa_intent_id": intent.ID},
	})
	if err != nil {
		// The claim expires for crash/provider-outage recovery. No local
		// payment is acknowledged until attachment succeeds.
		return Intent{}, err
	}
	if providerOrder.AmountPaise != intent.AmountPaise || providerOrder.Currency != intent.Currency || providerOrder.Receipt != intent.Receipt || providerOrder.ID == "" {
		return Intent{}, ErrProviderOrderMismatch
	}

	attached, attachedOK, err := s.store.AttachProviderOrder(ctx, intent.ID, claimToken, providerOrder.ID, now)
	if err != nil {
		return Intent{}, ErrOrderPersistence
	}
	if !attachedOK {
		return Intent{}, ErrOrderPersistence
	}
	return attached, nil
}

func randomClaimToken() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	// The SQL lease functions intentionally accept UUID tokens. Keep the
	// token opaque to callers, but generate a UUID-shaped value so the real
	// database path and the mocked unit path enforce the same contract.
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		value[0:4], value[4:6], value[6:8], value[8:10], value[10:16]), nil
}
