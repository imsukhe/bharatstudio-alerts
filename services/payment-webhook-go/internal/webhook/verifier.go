package webhook

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"
)

const (
	providerEventHeader = "X-Razorpay-Event-Id"
	signatureHeader     = "X-Razorpay-Signature"
	maxEventIDLength    = 200
)

var (
	ErrMissingEventID   = errors.New("missing x-razorpay-event-id")
	ErrInvalidEventID   = errors.New("invalid x-razorpay-event-id")
	ErrMissingSecret    = errors.New("missing webhook secret")
	ErrMissingSignature = errors.New("missing x-razorpay-signature")
	ErrInvalidSignature = errors.New("invalid x-razorpay-signature")
)

// Delivery is the verified provider identity that the persistence boundary
// must use for deduplication. It intentionally contains no parsed provider
// payload; signature verification always happens over the exact raw bytes.
type Delivery struct {
	ProviderEventID string
	RawBodyHash     string
}

// Verify validates the Razorpay webhook signature over rawBody and extracts
// the provider delivery identity. The caller must read and bound the request
// body before calling Verify, then persist Delivery atomically with the
// financial effect before returning HTTP 2xx.
func Verify(rawBody []byte, headers http.Header, secret string) (Delivery, error) {
	if secret == "" {
		return Delivery{}, ErrMissingSecret
	}
	eventID := strings.TrimSpace(headers.Get(providerEventHeader))
	if eventID == "" {
		return Delivery{}, ErrMissingEventID
	}
	if len(eventID) > maxEventIDLength {
		return Delivery{}, ErrInvalidEventID
	}
	for _, character := range eventID {
		if (character < 'A' || character > 'Z') &&
			(character < 'a' || character > 'z') &&
			(character < '0' || character > '9') &&
			character != '_' && character != '-' && character != '.' {
			return Delivery{}, ErrInvalidEventID
		}
	}

	received := strings.TrimSpace(headers.Get(signatureHeader))
	if received == "" {
		return Delivery{}, ErrMissingSignature
	}
	expected := hmac.New(sha256.New, []byte(secret))
	_, _ = expected.Write(rawBody)
	expectedBytes := expected.Sum(nil)
	receivedBytes, err := hex.DecodeString(received)
	if err != nil || len(receivedBytes) != sha256.Size || !hmac.Equal(expectedBytes, receivedBytes) {
		return Delivery{}, ErrInvalidSignature
	}

	hash := sha256.Sum256(rawBody)
	return Delivery{
		ProviderEventID: eventID,
		RawBodyHash:     hex.EncodeToString(hash[:]),
	}, nil
}
