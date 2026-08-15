package webhook

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"testing"
)

func signature(body []byte, secret string) string {
	h := hmac.New(sha256.New, []byte(secret))
	_, _ = h.Write(body)
	return hex.EncodeToString(h.Sum(nil))
}

func TestVerifyUsesRawBodyAndEventHeader(t *testing.T) {
	body := []byte(`{"event":"payment.captured","payload":{"payment":{"entity":{"id":"pay_test_1"}}}}`)
	headers := http.Header{}
	headers.Set("x-razorpay-signature", signature(body, "webhook-secret"))
	headers.Set("x-razorpay-event-id", "event_test_1")

	delivery, err := Verify(body, headers, "webhook-secret")
	if err != nil {
		t.Fatalf("Verify() error = %v", err)
	}
	if delivery.ProviderEventID != "event_test_1" {
		t.Fatalf("event id = %q", delivery.ProviderEventID)
	}
	if delivery.RawBodyHash == "" {
		t.Fatal("raw body hash is empty")
	}
}

func TestVerifyRejectsParsedOrChangedBody(t *testing.T) {
	body := []byte(`{"event":"payment.captured"}`)
	headers := http.Header{}
	headers.Set("X-Razorpay-Signature", signature(body, "webhook-secret"))
	headers.Set("X-Razorpay-Event-Id", "event_test_2")

	_, err := Verify([]byte(`{"event": "payment.captured"}`), headers, "webhook-secret")
	if !errors.Is(err, ErrInvalidSignature) {
		t.Fatalf("error = %v, want ErrInvalidSignature", err)
	}
}

func TestVerifyRequiresProviderEventIdentity(t *testing.T) {
	body := []byte(`{}`)
	headers := http.Header{}
	headers.Set("X-Razorpay-Signature", signature(body, "webhook-secret"))

	_, err := Verify(body, headers, "webhook-secret")
	if !errors.Is(err, ErrMissingEventID) {
		t.Fatalf("error = %v, want ErrMissingEventID", err)
	}
}

func TestVerifyRejectsBadSignatureAndOversizedEventID(t *testing.T) {
	body := []byte(`{}`)
	headers := http.Header{}
	headers.Set("X-Razorpay-Signature", "not-a-signature")
	headers.Set("X-Razorpay-Event-Id", "event_test_3")
	if _, err := Verify(body, headers, "webhook-secret"); !errors.Is(err, ErrInvalidSignature) {
		t.Fatalf("error = %v, want ErrInvalidSignature", err)
	}

	headers.Set("X-Razorpay-Signature", signature(body, "webhook-secret"))
	headers.Set("X-Razorpay-Event-Id", string(make([]byte, maxEventIDLength+1)))
	if _, err := Verify(body, headers, "webhook-secret"); !errors.Is(err, ErrInvalidEventID) {
		t.Fatalf("error = %v, want ErrInvalidEventID", err)
	}
}

func TestVerifyRejectsUnsafeEventIDCharacters(t *testing.T) {
	body := []byte(`{}`)
	headers := http.Header{}
	headers.Set("X-Razorpay-Signature", signature(body, "webhook-secret"))
	for _, eventID := range []string{"event with spaces", "event\nnewline", "event/other", "event:other"} {
		headers.Set("X-Razorpay-Event-Id", eventID)
		if _, err := Verify(body, headers, "webhook-secret"); !errors.Is(err, ErrInvalidEventID) {
			t.Fatalf("event ID %q error = %v, want ErrInvalidEventID", eventID, err)
		}
	}
}

func TestVerifyFailsClosedWithoutSecret(t *testing.T) {
	_, err := Verify([]byte(`{}`), http.Header{}, "")
	if !errors.Is(err, ErrMissingSecret) {
		t.Fatalf("error = %v, want ErrMissingSecret", err)
	}
}
