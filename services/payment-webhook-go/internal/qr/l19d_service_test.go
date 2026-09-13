package qr

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/bharatstudio/bharatstudio-alerts/services/payment-webhook-go/internal/provider"
)

type fakeIntents struct {
	intent EligibleIntent
	err    error
}

func (i *fakeIntents) GetEligibleIntent(context.Context, string, string, string) (EligibleIntent, error) {
	return i.intent, i.err
}

type fakeStore struct {
	record      Record
	acquired    bool
	attachOK    bool
	createCalls int
	claimCalls  int
	attachCalls int
}

func (s *fakeStore) CreateOrGetQr(_ context.Context, _ string, _ EligibleIntent, closeBy time.Time) (Record, error) {
	s.createCalls++
	if s.record.CloseBy.IsZero() {
		s.record.CloseBy = closeBy
	}
	return s.record, nil
}

func (s *fakeStore) ClaimQrProviderCreation(_ context.Context, _, _ string, _ time.Time) (Record, bool, error) {
	s.claimCalls++
	return s.record, s.acquired, nil
}

func (s *fakeStore) AttachProviderQr(_ context.Context, _, _, providerQrID, qrImageURL string, _ time.Time) (Record, bool, error) {
	s.attachCalls++
	s.record.ProviderQrID = providerQrID
	s.record.QrImageURL = qrImageURL
	s.record.Status = "provider_created"
	return s.record, s.attachOK, nil
}

type fakeQrClient struct {
	qrCode provider.QrCode
	err    error
	calls  int
	last   provider.CreateQrRequest
}

func (p *fakeQrClient) CreateUpiQrForAccount(_ context.Context, request provider.CreateQrRequest) (provider.QrCode, error) {
	p.calls++
	p.last = request
	return p.qrCode, p.err
}

func serviceFor(intents *fakeIntents, store *fakeStore, client *fakeQrClient) Service {
	service := NewService(intents, store, client)
	service.now = func() time.Time { return time.Unix(1700000000, 0) }
	service.token = func() (string, error) { return "claim-token", nil }
	return service
}

func validRequest() Request {
	return Request{
		IntentID:    "intent-1",
		ChannelID:   "channel-1",
		Environment: "test",
		CloseBy:     time.Unix(1700000600, 0),
	}
}

func TestCreateQrClaimsBeforeProviderAndAttachesAfterMatch(t *testing.T) {
	intents := &fakeIntents{intent: EligibleIntent{ID: "intent-1", ConnectedAccountRef: "acc_test", AmountPaise: 5000, Currency: "INR", Receipt: "receipt-1", Status: "provider_pending"}}
	store := &fakeStore{record: Record{ID: "qr-1", ConnectedAccountRef: "acc_test", AmountPaise: 5000, Currency: "INR", Receipt: "receipt-1"}, acquired: true, attachOK: true}
	client := &fakeQrClient{qrCode: provider.QrCode{ID: "qr_prov_1", ImageURL: "https://rzp.io/i/qr_prov_1.png", PaymentAmt: 5000}}

	result, err := serviceFor(intents, store, client).CreateQr(context.Background(), validRequest())
	if err != nil || result.ProviderQrID != "qr_prov_1" || result.QrImageURL != "https://rzp.io/i/qr_prov_1.png" {
		t.Fatalf("result=%#v err=%v", result, err)
	}
	if store.createCalls != 1 || store.claimCalls != 1 || store.attachCalls != 1 || client.calls != 1 {
		t.Fatalf("create=%d claim=%d attach=%d provider=%d", store.createCalls, store.claimCalls, store.attachCalls, client.calls)
	}
	if client.last.ConnectedAccountRef != "acc_test" || client.last.Notes["bsa_intent_id"] != "intent-1" {
		t.Fatalf("provider request=%#v", client.last)
	}
}

func TestCreateQrRejectsIntentThatIsAlreadyPaidOrClosed(t *testing.T) {
	for _, status := range []string{"paid", "expired", "failed"} {
		intents := &fakeIntents{intent: EligibleIntent{ID: "intent-1", ConnectedAccountRef: "acc_test", AmountPaise: 5000, Currency: "INR", Status: status}}
		store := &fakeStore{}
		client := &fakeQrClient{}
		_, err := serviceFor(intents, store, client).CreateQr(context.Background(), validRequest())
		if !errors.Is(err, ErrIntentNotEligible) {
			t.Fatalf("status=%s err=%v", status, err)
		}
		if store.createCalls != 0 || client.calls != 0 {
			t.Fatalf("status=%s must never create a qr row or call the provider: create=%d provider=%d", status, store.createCalls, client.calls)
		}
	}
}

func TestCreateQrDoesNotCallProviderWhenAnotherReplicaOwnsClaim(t *testing.T) {
	intents := &fakeIntents{intent: EligibleIntent{ID: "intent-1", ConnectedAccountRef: "acc_test", AmountPaise: 5000, Currency: "INR", Status: "provider_pending"}}
	store := &fakeStore{acquired: false}
	client := &fakeQrClient{}
	_, err := serviceFor(intents, store, client).CreateQr(context.Background(), validRequest())
	if !errors.Is(err, ErrQrCreationInProgress) || client.calls != 0 {
		t.Fatalf("err=%v provider_calls=%d", err, client.calls)
	}
}

func TestCreateQrReturnsExistingQrWithoutCallingProviderAgain(t *testing.T) {
	intents := &fakeIntents{intent: EligibleIntent{ID: "intent-1", ConnectedAccountRef: "acc_test", AmountPaise: 5000, Currency: "INR", Status: "provider_pending"}}
	store := &fakeStore{record: Record{ID: "qr-1", ProviderQrID: "qr_existing", QrImageURL: "https://rzp.io/i/qr_existing.png"}}
	client := &fakeQrClient{}
	result, err := serviceFor(intents, store, client).CreateQr(context.Background(), validRequest())
	if err != nil || result.ProviderQrID != "qr_existing" || client.calls != 0 {
		t.Fatalf("result=%#v err=%v provider_calls=%d", result, err, client.calls)
	}
}

func TestCreateQrRejectsProviderMismatchAndPersistenceFailure(t *testing.T) {
	intents := &fakeIntents{intent: EligibleIntent{ID: "intent-1", ConnectedAccountRef: "acc_test", AmountPaise: 5000, Currency: "INR", Status: "provider_pending"}}
	store := &fakeStore{record: Record{ID: "qr-1", AmountPaise: 5000}, acquired: true, attachOK: true}
	client := &fakeQrClient{qrCode: provider.QrCode{ID: "qr_prov_1", ImageURL: "https://rzp.io/i/qr_prov_1.png", PaymentAmt: 9999}}
	if _, err := serviceFor(intents, store, client).CreateQr(context.Background(), validRequest()); !errors.Is(err, ErrProviderQrMismatch) {
		t.Fatalf("mismatch error = %v", err)
	}

	client.qrCode = provider.QrCode{ID: "qr_prov_1", ImageURL: "https://rzp.io/i/qr_prov_1.png", PaymentAmt: 5000}
	store.attachOK = false
	if _, err := serviceFor(intents, store, client).CreateQr(context.Background(), validRequest()); !errors.Is(err, ErrQrPersistence) {
		t.Fatalf("attach error = %v", err)
	}
}
