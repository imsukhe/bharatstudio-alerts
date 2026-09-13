// Package qr is L19d: dynamic UPI QR creation for a payment_order_intents
// row that has not yet been paid. It mirrors internal/checkout's
// create-then-claim-then-attach shape deliberately — this codebase already
// has one proven answer to "how do we call an external payment API exactly
// once for a local row under concurrent retries", and QR creation is the
// same problem, so it reuses the same shape rather than inventing a second,
// unproven one.
//
// This package never marks anything paid. A QR is a scannable surface, not
// payment evidence — the payment made against it still arrives only through
// the existing verified webhook path (internal/webhook/verifier.go) exactly
// like an Orders-API payment does.
package qr

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"time"

	"github.com/bharatstudio/bharatstudio-alerts/services/payment-webhook-go/internal/provider"
)

var (
	ErrQrCreationInProgress = errors.New("qr creation already in progress")
	ErrProviderQrMismatch   = errors.New("provider qr did not match local intent")
	ErrIntentNotEligible    = errors.New("intent is not eligible for qr creation")
	ErrQrPersistence        = errors.New("qr persistence failed")
)

// Request is what a caller asks for: an existing, not-yet-paid tip intent
// and how long the QR should stay open.
type Request struct {
	IntentID    string
	ChannelID   string
	Environment string
	CloseBy     time.Time
	TraceID     string
}

// Record is the local QR row, one per intent.
type Record struct {
	ID                   string
	IntentID             string
	ConnectedAccountRef  string
	AmountPaise          int64
	Currency             string
	Receipt              string
	ProviderQrID         string
	QrImageURL           string
	Status               string
	CloseBy              time.Time
}

// IntentLookup resolves the immutable, already-persisted intent fields a QR
// must be created against. It never accepts amount/currency/account from
// the QR request itself — those come only from the local intent row, the
// same way checkout.Service pulls ConnectedAccountRef from the claimed
// intent rather than the caller.
type IntentLookup interface {
	GetEligibleIntent(ctx context.Context, intentID, channelID, environment string) (EligibleIntent, error)
}

// EligibleIntent is the subset of checkout.Intent needed to create a QR.
type EligibleIntent struct {
	ID                  string
	ConnectedAccountRef string
	AmountPaise         int64
	Currency            string
	Receipt             string
	Status              string
}

type Store interface {
	// CreateOrGetQr inserts a new pending QR row for the intent if one does
	// not exist yet, or returns the existing row unchanged (idempotent on
	// retry — same intent, same row, never a second QR for one intent).
	CreateOrGetQr(ctx context.Context, id string, intent EligibleIntent, closeBy time.Time) (Record, error)
	ClaimQrProviderCreation(ctx context.Context, qrID, claimToken string, claimUntil time.Time) (Record, bool, error)
	AttachProviderQr(ctx context.Context, qrID, claimToken, providerQrID, qrImageURL string, providerCreatedAt time.Time) (Record, bool, error)
}

type QrClient interface {
	CreateUpiQrForAccount(ctx context.Context, request provider.CreateQrRequest) (provider.QrCode, error)
}

type Service struct {
	intents  IntentLookup
	store    Store
	provider QrClient
	now      func() time.Time
	token    func() (string, error)
	claimFor time.Duration
}

func NewService(intents IntentLookup, store Store, client QrClient) Service {
	return Service{
		intents:  intents,
		store:    store,
		provider: client,
		now:      time.Now,
		token:    randomClaimToken,
		claimFor: 20 * time.Second,
	}
}

func (s Service) CreateQr(ctx context.Context, request Request) (Record, error) {
	if s.intents == nil || s.store == nil || s.provider == nil {
		return Record{}, ErrQrPersistence
	}
	intent, err := s.intents.GetEligibleIntent(ctx, request.IntentID, request.ChannelID, request.Environment)
	if err != nil {
		return Record{}, err
	}
	// A QR is only ever offered while the underlying intent is still open.
	// An intent that already has a captured payment, has expired, or has
	// failed must never grow a second, independent path to money.
	if intent.Status != "provider_pending" && intent.Status != "provider_created" {
		return Record{}, ErrIntentNotEligible
	}
	if intent.ConnectedAccountRef == "" {
		return Record{}, ErrIntentNotEligible
	}

	id, err := randomClaimToken()
	if err != nil {
		return Record{}, ErrQrPersistence
	}
	record, err := s.store.CreateOrGetQr(ctx, id, intent, request.CloseBy)
	if err != nil {
		return Record{}, err
	}
	if record.ProviderQrID != "" {
		return record, nil
	}

	claimToken, err := s.token()
	if err != nil || claimToken == "" {
		return Record{}, ErrQrPersistence
	}
	now := s.now()
	claimed, acquired, err := s.store.ClaimQrProviderCreation(ctx, record.ID, claimToken, now.Add(s.claimFor))
	if err != nil {
		return Record{}, err
	}
	if !acquired {
		if claimed.ProviderQrID != "" {
			return claimed, nil
		}
		return Record{}, ErrQrCreationInProgress
	}
	claimed.ConnectedAccountRef = record.ConnectedAccountRef

	providerQr, err := s.provider.CreateUpiQrForAccount(ctx, provider.CreateQrRequest{
		AmountPaise:          claimed.AmountPaise,
		Currency:             claimed.Currency,
		Receipt:              claimed.Receipt,
		ConnectedAccountRef:  claimed.ConnectedAccountRef,
		CloseBy:              record.CloseBy,
		Notes:                map[string]string{"bsa_intent_id": intent.ID},
	})
	if err != nil {
		// The claim expires for crash/provider-outage recovery, exactly like
		// checkout.Service's order-creation claim.
		return Record{}, err
	}
	if providerQr.PaymentAmt != claimed.AmountPaise || providerQr.ID == "" || providerQr.ImageURL == "" {
		return Record{}, ErrProviderQrMismatch
	}

	attached, attachedOK, err := s.store.AttachProviderQr(ctx, record.ID, claimToken, providerQr.ID, providerQr.ImageURL, now)
	if err != nil {
		return Record{}, ErrQrPersistence
	}
	if !attachedOK {
		return Record{}, ErrQrPersistence
	}
	return attached, nil
}

func randomClaimToken() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		value[0:4], value[4:6], value[6:8], value[8:10], value[10:16]), nil
}
