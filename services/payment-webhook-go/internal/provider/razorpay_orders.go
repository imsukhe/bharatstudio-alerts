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

const (
	defaultAPIBaseURL  = "https://api.razorpay.com"
	defaultHTTPTimeout = 5
	maxResponseBytes   = 1 << 20
	minAmountPaise     = int64(1000)
	maxReceiptBytes    = 40
	maxNotes           = 15
	maxNoteBytes       = 256
)

var (
	ErrInvalidClientConfig = errors.New("invalid razorpay client configuration")
	ErrInvalidOrderRequest = errors.New("invalid razorpay order request")
	ErrProviderResponse    = errors.New("invalid razorpay provider response")
	ErrOrderMismatch       = errors.New("razorpay order response mismatch")
)

// CreateOrderRequest contains only server-owned order fields. The caller must
// create and persist its local payment/order intent before calling Razorpay;
// Receipt is a provider-side duplicate guard, not a replacement for the
// BharatStudio database uniqueness constraint.
type CreateOrderRequest struct {
	AmountPaise int64
	Currency    string
	Receipt     string
	// ConnectedAccountRef is the server-resolved Razorpay linked-account ID.
	// It is sent as X-Razorpay-Account and is never accepted from a browser.
	ConnectedAccountRef string
	Notes               map[string]string
	PartialPayment      bool
}

type Order struct {
	Entity      string `json:"entity"`
	ID          string `json:"id"`
	AmountPaise int64  `json:"amount"`
	AmountDue   int64  `json:"amount_due"`
	AmountPaid  int64  `json:"amount_paid"`
	Currency    string `json:"currency"`
	Receipt     string `json:"receipt"`
	Status      string `json:"status"`
	Attempts    int    `json:"attempts"`
	CreatedAt   int64  `json:"created_at"`
}

// Payment is the minimal provider projection used by recovery. It is fetched
// from the order's payment collection, never trusted from a browser or an
// order-level paid flag alone.
type Payment struct {
	Entity      string `json:"entity"`
	ID          string `json:"id"`
	AmountPaise int64  `json:"amount"`
	Currency    string `json:"currency"`
	Status      string `json:"status"`
	OrderID     string `json:"order_id"`
}

type Refund struct {
	Entity      string `json:"entity"`
	ID          string `json:"id"`
	AmountPaise int64  `json:"amount"`
	Currency    string `json:"currency"`
	PaymentID   string `json:"payment_id"`
	Status      string `json:"status"`
}

// Client is a small, testable Razorpay Orders API adapter. It does not persist
// any payment state and it never returns provider error bodies to callers.
type Client struct {
	baseURL          *url.URL
	keyID            string
	keySecret        string
	httpClient       *http.Client
	maxResponseBytes int64
}

func NewRazorpayClient(baseURL, keyID, keySecret string, httpClient *http.Client) (Client, error) {
	if baseURL == "" {
		baseURL = defaultAPIBaseURL
	}
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		return Client{}, ErrInvalidClientConfig
	}
	if keyID == "" || keySecret == "" {
		return Client{}, ErrInvalidClientConfig
	}
	if httpClient == nil {
		httpClient = &http.Client{Timeout: defaultHTTPTimeout * time.Second}
	}
	return Client{
		baseURL:          parsed,
		keyID:            keyID,
		keySecret:        keySecret,
		httpClient:       httpClient,
		maxResponseBytes: maxResponseBytes,
	}, nil
}

func (c Client) CreateOrder(ctx context.Context, request CreateOrderRequest) (Order, error) {
	if err := validateCreateOrderRequest(request); err != nil {
		return Order{}, err
	}
	body, err := json.Marshal(struct {
		Amount         int64             `json:"amount"`
		Currency       string            `json:"currency"`
		Receipt        string            `json:"receipt"`
		Notes          map[string]string `json:"notes,omitempty"`
		PartialPayment bool              `json:"partial_payment,omitempty"`
	}{
		Amount:         request.AmountPaise,
		Currency:       request.Currency,
		Receipt:        request.Receipt,
		Notes:          request.Notes,
		PartialPayment: request.PartialPayment,
	})
	if err != nil {
		return Order{}, fmt.Errorf("marshal razorpay order request: %w", err)
	}
	return c.doOrderRequest(ctx, http.MethodPost, "/v1/orders", bytes.NewReader(body), &request, request.ConnectedAccountRef)
}

// FetchOrderForAccount fetches an order in the server-resolved linked account.
func (c Client) FetchOrderForAccount(ctx context.Context, connectedAccountRef, orderID string) (Order, error) {
	if !validConnectedAccountRef(connectedAccountRef) || !validProviderID(orderID) {
		return Order{}, ErrInvalidOrderRequest
	}
	path := "/v1/orders/" + url.PathEscape(orderID)
	order, err := c.doOrderRequest(ctx, http.MethodGet, path, nil, nil, connectedAccountRef)
	if err != nil {
		return Order{}, err
	}
	// The path is server-selected from the immutable local intent. A provider
	// response for another order must fail at this boundary, before any caller
	// can interpret its status as evidence for the requested intent.
	if order.ID != orderID {
		return Order{}, fmt.Errorf("%w: fetched order id mismatch", ErrProviderResponse)
	}
	return order, nil
}

// FetchOrderPayments retrieves the payment collection for an order. Razorpay
// documents this as GET /v1/orders/:id/payments; the recovery path uses only a
// captured payment whose immutable order, amount and currency match locally.
// FetchOrderPaymentsForAccount fetches payment evidence in the linked account.
func (c Client) FetchOrderPaymentsForAccount(ctx context.Context, connectedAccountRef, orderID string) ([]Payment, error) {
	if !validConnectedAccountRef(connectedAccountRef) || !validProviderID(orderID) {
		return nil, ErrInvalidOrderRequest
	}
	path := "/v1/orders/" + url.PathEscape(orderID) + "/payments"
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL.ResolveReference(&url.URL{Path: path}).String(), nil)
	if err != nil {
		return nil, fmt.Errorf("create razorpay request: %w", err)
	}
	request.SetBasicAuth(c.keyID, c.keySecret)
	setConnectedAccountHeader(request, connectedAccountRef)
	response, err := c.httpClient.Do(request)
	if err != nil {
		return nil, &ProviderError{Operation: http.MethodGet + " " + path, Retryable: true, Cause: err}
	}
	defer response.Body.Close()
	limit := c.maxResponseBytes
	if limit <= 0 {
		limit = maxResponseBytes
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil || int64(len(raw)) > limit {
		return nil, &ProviderError{Operation: http.MethodGet + " " + path, StatusCode: response.StatusCode, Retryable: true, Cause: errors.New("response unavailable")}
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return nil, &ProviderError{Operation: http.MethodGet + " " + path, StatusCode: response.StatusCode, Retryable: response.StatusCode == http.StatusRequestTimeout || response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= 500}
	}
	var collection struct {
		Entity string    `json:"entity"`
		Items  []Payment `json:"items"`
	}
	if err := json.Unmarshal(raw, &collection); err != nil || collection.Entity != "collection" {
		return nil, fmt.Errorf("%w: decode payment collection", ErrProviderResponse)
	}
	for _, payment := range collection.Items {
		if !validProviderID(payment.ID) || payment.Entity != "payment" || payment.OrderID != orderID || payment.AmountPaise < minAmountPaise || payment.Currency != "INR" {
			return nil, fmt.Errorf("%w: invalid payment projection", ErrProviderResponse)
		}
	}
	return collection.Items, nil
}

// FetchRefund retrieves one refund for reconciliation. The provider exposes
// pending, processed, failed and reversed states; the local persistence
// boundary decides which compensating transition is allowed.
// FetchRefundForAccount fetches refund evidence in the linked account.
func (c Client) FetchRefundForAccount(ctx context.Context, connectedAccountRef, refundID string) (Refund, error) {
	if !validConnectedAccountRef(connectedAccountRef) || !validProviderID(refundID) {
		return Refund{}, ErrInvalidOrderRequest
	}
	path := "/v1/refunds/" + url.PathEscape(refundID)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL.ResolveReference(&url.URL{Path: path}).String(), nil)
	if err != nil {
		return Refund{}, fmt.Errorf("create razorpay request: %w", err)
	}
	request.SetBasicAuth(c.keyID, c.keySecret)
	setConnectedAccountHeader(request, connectedAccountRef)
	response, err := c.httpClient.Do(request)
	if err != nil {
		return Refund{}, &ProviderError{Operation: http.MethodGet + " " + path, Retryable: true, Cause: err}
	}
	defer response.Body.Close()
	limit := c.maxResponseBytes
	if limit <= 0 {
		limit = maxResponseBytes
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil || int64(len(raw)) > limit {
		return Refund{}, &ProviderError{Operation: http.MethodGet + " " + path, StatusCode: response.StatusCode, Retryable: true, Cause: errors.New("response unavailable")}
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return Refund{}, &ProviderError{Operation: http.MethodGet + " " + path, StatusCode: response.StatusCode, Retryable: response.StatusCode == http.StatusRequestTimeout || response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= 500}
	}
	var refund Refund
	if err := json.Unmarshal(raw, &refund); err != nil || refund.Entity != "refund" || !validProviderID(refund.ID) || refund.ID != refundID || !validProviderID(refund.PaymentID) || refund.AmountPaise <= 0 {
		return Refund{}, fmt.Errorf("%w: decode refund", ErrProviderResponse)
	}
	return refund, nil
}

func (c Client) doOrderRequest(ctx context.Context, method, path string, body io.Reader, expected *CreateOrderRequest, connectedAccountRef string) (Order, error) {
	endpoint := c.baseURL.ResolveReference(&url.URL{Path: path})
	request, err := http.NewRequestWithContext(ctx, method, endpoint.String(), body)
	if err != nil {
		return Order{}, fmt.Errorf("create razorpay request: %w", err)
	}
	request.SetBasicAuth(c.keyID, c.keySecret)
	setConnectedAccountHeader(request, connectedAccountRef)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := c.httpClient.Do(request)
	if err != nil {
		return Order{}, &ProviderError{Operation: method + " " + path, Retryable: true, Cause: err}
	}
	defer response.Body.Close()

	limit := c.maxResponseBytes
	if limit <= 0 {
		limit = maxResponseBytes
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return Order{}, &ProviderError{Operation: method + " " + path, StatusCode: response.StatusCode, Retryable: true, Cause: err}
	}
	if int64(len(raw)) > limit {
		return Order{}, &ProviderError{Operation: method + " " + path, StatusCode: response.StatusCode, Retryable: true, Cause: errors.New("response too large")}
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return Order{}, &ProviderError{
			Operation:  method + " " + path,
			StatusCode: response.StatusCode,
			Retryable:  response.StatusCode == http.StatusRequestTimeout || response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= 500,
		}
	}
	var order Order
	if err := json.Unmarshal(raw, &order); err != nil {
		return Order{}, fmt.Errorf("%w: decode order", ErrProviderResponse)
	}
	if !validProviderID(order.ID) || order.Entity != "order" {
		return Order{}, fmt.Errorf("%w: entity or id", ErrProviderResponse)
	}
	if expected != nil {
		if order.AmountPaise != expected.AmountPaise || order.Currency != expected.Currency || order.Receipt != expected.Receipt {
			return Order{}, ErrOrderMismatch
		}
	}
	return order, nil
}

type ProviderError struct {
	Operation  string
	StatusCode int
	Retryable  bool
	Cause      error
}

func (e *ProviderError) Error() string {
	if e.StatusCode != 0 {
		return fmt.Sprintf("razorpay %s failed with status %d", e.Operation, e.StatusCode)
	}
	return fmt.Sprintf("razorpay %s failed", e.Operation)
}

func (e *ProviderError) Unwrap() error { return e.Cause }

func validateCreateOrderRequest(request CreateOrderRequest) error {
	if !validConnectedAccountRef(request.ConnectedAccountRef) || request.AmountPaise < minAmountPaise || strings.ToUpper(request.Currency) != "INR" || request.Currency != "INR" {
		return ErrInvalidOrderRequest
	}
	if request.Receipt == "" || len([]byte(request.Receipt)) > maxReceiptBytes {
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

func validConnectedAccountRef(value string) bool {
	return value != "" && len(value) <= 64 && validProviderID(value)
}

func setConnectedAccountHeader(request *http.Request, connectedAccountRef string) {
	if connectedAccountRef != "" {
		request.Header.Set("X-Razorpay-Account", connectedAccountRef)
	}
}

func validProviderID(value string) bool {
	if value == "" || len(value) > 128 {
		return false
	}
	for _, character := range value {
		if (character < 'A' || character > 'Z') &&
			(character < 'a' || character > 'z') &&
			(character < '0' || character > '9') &&
			character != '_' && character != '-' {
			return false
		}
	}
	return true
}
