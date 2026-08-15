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
)

const (
	minSubscriptionCount = 1
	maxSubscriptionCount = 120
	minSubscriptionQty   = 1
	maxSubscriptionQty   = 10
)

// CreateSubscriptionRequest contains only server-selected subscription
// fields. PlanID must come from BharatStudio's approved tier/interval mapping;
// it must never be accepted as an arbitrary browser value.
type CreateSubscriptionRequest struct {
	// ProviderAccountRef is the Razorpay account that owns the subscription.
	// For a platform subscription this is used for webhook attribution only;
	// it is not sent as X-Razorpay-Account.
	ProviderAccountRef string
	// AccountScope is "platform" for BharatStudio plan billing or "connected"
	// for a creator-owned provider account. Empty is rejected to avoid silently
	// routing a platform purchase through a creator account.
	AccountScope   string
	PlanID         string
	TotalCount     int
	Quantity       int
	CustomerNotify bool
	StartAt        int64
	ExpireBy       int64
	Notes          map[string]string
}

// Subscription is the bounded provider projection used to create the
// server-owned channel_subscription_links row. It is not a billing authority;
// verified webhooks and reconciliation remain authoritative for access.
type Subscription struct {
	Entity         string `json:"entity"`
	ID             string `json:"id"`
	PlanID         string `json:"plan_id"`
	Status         string `json:"status"`
	ShortURL       string `json:"short_url"`
	CurrentStart   int64  `json:"current_start"`
	CurrentEnd     int64  `json:"current_end"`
	ChargeAt       int64  `json:"charge_at"`
	TotalCount     int    `json:"total_count"`
	PaidCount      int    `json:"paid_count"`
	RemainingCount int    `json:"remaining_count"`
}

// CreateSubscription creates a provider subscription only after the caller
// has resolved the channel's provider account and approved plan. The
// response is checked against the requested plan before it can be linked to a
// channel.
func (c Client) CreateSubscription(ctx context.Context, request CreateSubscriptionRequest) (Subscription, error) {
	if err := validateCreateSubscriptionRequest(request); err != nil {
		return Subscription{}, err
	}
	body, err := json.Marshal(struct {
		PlanID         string            `json:"plan_id"`
		TotalCount     int               `json:"total_count"`
		Quantity       int               `json:"quantity"`
		CustomerNotify bool              `json:"customer_notify"`
		StartAt        int64             `json:"start_at,omitempty"`
		ExpireBy       int64             `json:"expire_by,omitempty"`
		Notes          map[string]string `json:"notes,omitempty"`
	}{
		PlanID:         request.PlanID,
		TotalCount:     request.TotalCount,
		Quantity:       request.Quantity,
		CustomerNotify: request.CustomerNotify,
		StartAt:        request.StartAt,
		ExpireBy:       request.ExpireBy,
		Notes:          request.Notes,
	})
	if err != nil {
		return Subscription{}, fmt.Errorf("marshal razorpay subscription request: %w", err)
	}

	path := "/v1/subscriptions"
	endpoint := c.baseURL.ResolveReference(&url.URL{Path: path})
	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return Subscription{}, fmt.Errorf("create razorpay subscription request: %w", err)
	}
	httpRequest.SetBasicAuth(c.keyID, c.keySecret)
	httpRequest.Header.Set("Content-Type", "application/json")
	if request.AccountScope == "connected" {
		setConnectedAccountHeader(httpRequest, request.ProviderAccountRef)
	}

	response, err := c.httpClient.Do(httpRequest)
	if err != nil {
		return Subscription{}, &ProviderError{Operation: http.MethodPost + " " + path, Retryable: true, Cause: err}
	}
	defer response.Body.Close()

	limit := c.maxResponseBytes
	if limit <= 0 {
		limit = maxResponseBytes
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil || int64(len(raw)) > limit {
		return Subscription{}, &ProviderError{Operation: http.MethodPost + " " + path, StatusCode: response.StatusCode, Retryable: true, Cause: errors.New("response unavailable")}
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return Subscription{}, &ProviderError{
			Operation:  http.MethodPost + " " + path,
			StatusCode: response.StatusCode,
			Retryable:  response.StatusCode == http.StatusRequestTimeout || response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= 500,
		}
	}

	var subscription Subscription
	if err := json.Unmarshal(raw, &subscription); err != nil {
		return Subscription{}, fmt.Errorf("%w: decode subscription", ErrProviderResponse)
	}
	if subscription.Entity != "subscription" || !validProviderID(subscription.ID) || subscription.PlanID != request.PlanID || strings.TrimSpace(subscription.Status) == "" {
		return Subscription{}, fmt.Errorf("%w: subscription identity or plan mismatch", ErrProviderResponse)
	}
	return subscription, nil
}

func validateCreateSubscriptionRequest(request CreateSubscriptionRequest) error {
	if !validConnectedAccountRef(request.ProviderAccountRef) || (request.AccountScope != "platform" && request.AccountScope != "connected") || !validProviderID(request.PlanID) {
		return ErrInvalidOrderRequest
	}
	if request.TotalCount < minSubscriptionCount || request.TotalCount > maxSubscriptionCount || request.Quantity < minSubscriptionQty || request.Quantity > maxSubscriptionQty {
		return ErrInvalidOrderRequest
	}
	if request.StartAt < 0 || request.ExpireBy < 0 || (request.StartAt != 0 && request.ExpireBy != 0 && request.ExpireBy <= request.StartAt) {
		return ErrInvalidOrderRequest
	}
	if len(request.Notes) > maxNotes {
		return ErrInvalidOrderRequest
	}
	for key, value := range request.Notes {
		if key == "" || len([]byte(key)) > maxNoteBytes || len([]byte(value)) > maxNoteBytes {
			return ErrInvalidOrderRequest
		}
	}
	return nil
}
