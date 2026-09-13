package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// L19d — dynamic UPI QR creation. This is a genuinely new Razorpay call: no
// QR-creation request existed anywhere in this codebase before this task
// (grepped services/payment-webhook-go and apps/api). It is intentionally a
// second, narrower client method next to CreateOrder rather than a field on
// CreateOrderRequest, because Razorpay's QR Code entity
// (POST /v1/payments/qr_codes) is not an Orders-API object: it has its own
// id space, its own status vocabulary, and is not "attached" to an order the
// way a payment is. A payment later made against this QR arrives through the
// existing verified webhook path exactly like an Orders-API payment does —
// this call only ever produces a scannable image, never payment status.
//
// No instrument data crosses this call in either direction: the request
// carries only amount/currency/receipt/expiry: the response carries only an
// id, an image URL and a status. The viewer's UPI app, not BharatStudio,
// collects the VPA/PIN when they scan.
const (
	qrCodeMinAmountPaise = int64(1000)
	qrCodeMaxNoteBytes   = 256
	qrCodeMaxNotes       = 15
)

var (
	ErrInvalidQrRequest  = errors.New("invalid razorpay qr request")
	ErrQrProviderMismatch = errors.New("razorpay qr response mismatch")
)

// CreateQrRequest contains only server-owned QR fields, mirroring
// CreateOrderRequest's shape and validation posture.
type CreateQrRequest struct {
	AmountPaise int64
	Currency    string
	Receipt     string
	// ConnectedAccountRef is the server-resolved Razorpay linked-account ID.
	// It is sent as X-Razorpay-Account and is never accepted from a browser.
	ConnectedAccountRef string
	// CloseBy is the provider-side expiry. Razorpay requires this in the
	// future; BharatStudio additionally caps it the same way checkout caps
	// order lifetime (see checkout.maxCheckoutLifetime), enforced by the
	// caller, not this client.
	CloseBy time.Time
	Notes   map[string]string
}

// QrCode is the minimal provider projection this codebase needs: enough to
// render a scannable image and to know it is still open. It is never used
// to infer payment status — see this file's header comment.
type QrCode struct {
	Entity      string `json:"entity"`
	ID          string `json:"id"`
	Type        string `json:"type"`
	Status      string `json:"status"`
	ImageURL    string `json:"image_url"`
	PaymentAmt  int64  `json:"payment_amount"`
	FixedAmount bool   `json:"fixed_amount"`
	CloseBy     int64  `json:"close_by"`
}

// CreateUpiQrForAccount creates a single-use, fixed-amount dynamic UPI QR
// code in the server-resolved linked account. Unlike CreateOrder, Razorpay's
// QR Code API has no local-mismatch replay guard on GET, so the caller
// (internal/qr.Service) is responsible for not calling this twice for the
// same local row — this client performs exactly one network call per
// invocation and never retries internally.
func (c Client) CreateUpiQrForAccount(ctx context.Context, request CreateQrRequest) (QrCode, error) {
	if err := validateCreateQrRequest(request); err != nil {
		return QrCode{}, err
	}
	body, err := json.Marshal(struct {
		Type          string            `json:"type"`
		Usage         string            `json:"usage"`
		FixedAmount   bool              `json:"fixed_amount"`
		PaymentAmount int64             `json:"payment_amount"`
		Description   string            `json:"description,omitempty"`
		CloseBy       int64             `json:"close_by"`
		Notes         map[string]string `json:"notes,omitempty"`
	}{
		Type:          "upi_qr",
		Usage:         "single_use",
		FixedAmount:   true,
		PaymentAmount: request.AmountPaise,
		Description:   request.Receipt,
		CloseBy:       request.CloseBy.Unix(),
		Notes:         request.Notes,
	})
	if err != nil {
		return QrCode{}, fmt.Errorf("marshal razorpay qr request: %w", err)
	}
	const path = "/v1/payments/qr_codes"
	endpoint := c.baseURL.ResolveReference(&url.URL{Path: path})
	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return QrCode{}, fmt.Errorf("create razorpay request: %w", err)
	}
	httpRequest.SetBasicAuth(c.keyID, c.keySecret)
	httpRequest.Header.Set("Content-Type", "application/json")
	setConnectedAccountHeader(httpRequest, request.ConnectedAccountRef)

	response, err := c.httpClient.Do(httpRequest)
	if err != nil {
		return QrCode{}, &ProviderError{Operation: http.MethodPost + " " + path, Retryable: true, Cause: err}
	}
	defer response.Body.Close()

	limit := c.maxResponseBytes
	if limit <= 0 {
		limit = maxResponseBytes
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return QrCode{}, &ProviderError{Operation: http.MethodPost + " " + path, StatusCode: response.StatusCode, Retryable: true, Cause: err}
	}
	if int64(len(raw)) > limit {
		return QrCode{}, &ProviderError{Operation: http.MethodPost + " " + path, StatusCode: response.StatusCode, Retryable: true, Cause: errors.New("response too large")}
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return QrCode{}, &ProviderError{
			Operation:  http.MethodPost + " " + path,
			StatusCode: response.StatusCode,
			Retryable:  response.StatusCode == http.StatusRequestTimeout || response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= 500,
		}
	}
	var qr QrCode
	if err := json.Unmarshal(raw, &qr); err != nil {
		return QrCode{}, fmt.Errorf("%w: decode qr code", ErrProviderResponse)
	}
	if qr.Entity != "qr_code" || !validProviderID(qr.ID) {
		return QrCode{}, fmt.Errorf("%w: entity or id", ErrProviderResponse)
	}
	if qr.Type != "upi_qr" || !qr.FixedAmount || qr.PaymentAmt != request.AmountPaise {
		return QrCode{}, ErrQrProviderMismatch
	}
	if qr.ImageURL == "" || !strings.HasPrefix(qr.ImageURL, "https://") {
		return QrCode{}, fmt.Errorf("%w: image url", ErrProviderResponse)
	}
	return qr, nil
}

func validateCreateQrRequest(request CreateQrRequest) error {
	if !validConnectedAccountRef(request.ConnectedAccountRef) || request.AmountPaise < qrCodeMinAmountPaise || strings.ToUpper(request.Currency) != "INR" || request.Currency != "INR" {
		return ErrInvalidQrRequest
	}
	if request.Receipt == "" || len([]byte(request.Receipt)) > maxReceiptBytes {
		return ErrInvalidQrRequest
	}
	if request.CloseBy.IsZero() {
		return ErrInvalidQrRequest
	}
	if len(request.Notes) > qrCodeMaxNotes {
		return ErrInvalidQrRequest
	}
	for key, value := range request.Notes {
		if key == "" || len([]byte(key)) > qrCodeMaxNoteBytes || len([]byte(value)) > qrCodeMaxNoteBytes {
			return ErrInvalidQrRequest
		}
	}
	return nil
}
