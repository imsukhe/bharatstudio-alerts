package provider

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func testClient(t *testing.T, server *httptest.Server) Client {
	t.Helper()
	baseURL, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	return Client{
		baseURL:          baseURL,
		keyID:            "rzp_test_key",
		keySecret:        "test_secret",
		httpClient:       server.Client(),
		maxResponseBytes: maxResponseBytes,
	}
}

func TestCreateOrderSendsServerOwnedRequestAndParsesOrder(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/v1/orders" {
			t.Fatalf("unexpected request: %s %s", request.Method, request.URL.Path)
		}
		keyID, secret, ok := request.BasicAuth()
		if !ok || keyID != "rzp_test_key" || secret != "test_secret" {
			t.Fatalf("unexpected basic auth: %q %q %v", keyID, secret, ok)
		}
		if request.Header.Get("Content-Type") != "application/json" {
			t.Fatalf("content type = %q", request.Header.Get("Content-Type"))
		}
		if request.Header.Get("X-Razorpay-Account") != "acc_test_creator" {
			t.Fatalf("connected account = %q", request.Header.Get("X-Razorpay-Account"))
		}
		var body map[string]any
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["amount"] != float64(5000) || body["currency"] != "INR" || body["receipt"] != "tip_123" {
			t.Fatalf("unexpected request body: %#v", body)
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(response, `{"entity":"order","id":"order_123","amount":5000,"amount_due":5000,"amount_paid":0,"currency":"INR","receipt":"tip_123","status":"created","attempts":0,"created_at":1700000000}`)
	}))
	defer server.Close()

	order, err := testClient(t, server).CreateOrder(context.Background(), CreateOrderRequest{
		AmountPaise:         5000,
		Currency:            "INR",
		Receipt:             "tip_123",
		ConnectedAccountRef: "acc_test_creator",
		Notes:               map[string]string{"channel_id": "channel_123"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if order.ID != "order_123" || order.AmountPaise != 5000 || order.Status != "created" {
		t.Fatalf("unexpected order: %#v", order)
	}
}

func TestFetchOrderUsesBoundedProviderResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet || request.URL.Path != "/v1/orders/order_123" {
			t.Fatalf("unexpected request: %s %s", request.Method, request.URL.Path)
		}
		_, _ = io.WriteString(response, `{"entity":"order","id":"order_123","amount":1000,"amount_due":0,"amount_paid":1000,"currency":"INR","receipt":"tip_1","status":"paid","attempts":1,"created_at":1700000000}`)
	}))
	defer server.Close()

	order, err := testClient(t, server).FetchOrderForAccount(context.Background(), "acc_test_creator", "order_123")
	if err != nil || order.Status != "paid" || order.AmountPaid != 1000 {
		t.Fatalf("fetch order = %#v, err = %v", order, err)
	}
}

func TestFetchOrderRejectsResponseForDifferentOrderID(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1/orders/order_123" {
			t.Fatalf("unexpected request path: %s", request.URL.Path)
		}
		_, _ = io.WriteString(response, `{"entity":"order","id":"order_other","amount":1000,"amount_due":1000,"amount_paid":0,"currency":"INR","receipt":"tip_1","status":"created","attempts":0,"created_at":1700000000}`)
	}))
	defer server.Close()

	if _, err := testClient(t, server).FetchOrderForAccount(context.Background(), "acc_test_creator", "order_123"); !errors.Is(err, ErrProviderResponse) {
		t.Fatalf("error = %v, want provider response mismatch", err)
	}
}

func TestFetchOrderPaymentsUsesOrderScopedPaymentCollection(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet || request.URL.Path != "/v1/orders/order_123/payments" {
			t.Fatalf("unexpected request: %s %s", request.Method, request.URL.Path)
		}
		_, _ = io.WriteString(response, `{"entity":"collection","count":1,"items":[{"entity":"payment","id":"pay_123","amount":5000,"currency":"INR","status":"captured","order_id":"order_123"}]}`)
	}))
	defer server.Close()

	payments, err := testClient(t, server).FetchOrderPaymentsForAccount(context.Background(), "acc_test_creator", "order_123")
	if err != nil || len(payments) != 1 || payments[0].ID != "pay_123" || payments[0].Status != "captured" {
		t.Fatalf("payments=%#v err=%v", payments, err)
	}
}

func TestFetchOrderPaymentsRejectsMismatchedPayment(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		_, _ = io.WriteString(response, `{"entity":"collection","items":[{"entity":"payment","id":"pay_123","amount":5000,"currency":"INR","status":"captured","order_id":"other_order"}]}`)
	}))
	defer server.Close()

	if _, err := testClient(t, server).FetchOrderPaymentsForAccount(context.Background(), "acc_test_creator", "order_123"); !errors.Is(err, ErrProviderResponse) {
		t.Fatalf("error=%v", err)
	}
}

func TestFetchRefundUsesRefundEndpointAndParsesPaymentLink(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet || request.URL.Path != "/v1/refunds/rfnd_123" {
			t.Fatalf("unexpected request: %s %s", request.Method, request.URL.Path)
		}
		_, _ = io.WriteString(response, `{"entity":"refund","id":"rfnd_123","amount":2500,"currency":"INR","payment_id":"pay_123","status":"processed"}`)
	}))
	defer server.Close()

	refund, err := testClient(t, server).FetchRefundForAccount(context.Background(), "acc_test_creator", "rfnd_123")
	if err != nil || refund.ID != "rfnd_123" || refund.PaymentID != "pay_123" || refund.Status != "processed" {
		t.Fatalf("refund=%#v err=%v", refund, err)
	}
}

func TestCreateSubscriptionSendsServerOwnedPlanAndAccount(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/v1/subscriptions" {
			t.Fatalf("unexpected request: %s %s", request.Method, request.URL.Path)
		}
		keyID, secret, ok := request.BasicAuth()
		if !ok || keyID != "rzp_test_key" || secret != "test_secret" {
			t.Fatalf("unexpected basic auth: %q %q %v", keyID, secret, ok)
		}
		if request.Header.Get("X-Razorpay-Account") != "acc_test_creator" {
			t.Fatalf("connected account = %q", request.Header.Get("X-Razorpay-Account"))
		}
		var body map[string]any
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["plan_id"] != "plan_creator_monthly" || body["total_count"] != float64(12) || body["quantity"] != float64(1) || body["customer_notify"] != true {
			t.Fatalf("unexpected subscription request body: %#v", body)
		}
		_, _ = io.WriteString(response, `{"entity":"subscription","id":"sub_123","plan_id":"plan_creator_monthly","status":"created","total_count":12,"paid_count":0,"remaining_count":12}`)
	}))
	defer server.Close()

	subscription, err := testClient(t, server).CreateSubscription(context.Background(), CreateSubscriptionRequest{
		ProviderAccountRef: "acc_test_creator",
		AccountScope:       "connected",
		PlanID:             "plan_creator_monthly",
		TotalCount:         12,
		Quantity:           1,
		CustomerNotify:     true,
		Notes:              map[string]string{"channel_id": "channel_123"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if subscription.ID != "sub_123" || subscription.PlanID != "plan_creator_monthly" || subscription.Status != "created" {
		t.Fatalf("unexpected subscription: %#v", subscription)
	}
}

func TestCreateSubscriptionRejectsInvalidRequestsBeforeNetwork(t *testing.T) {
	called := false
	server := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) { called = true }))
	defer server.Close()

	cases := []CreateSubscriptionRequest{
		{ProviderAccountRef: "acc_test_creator", AccountScope: "connected", PlanID: "plan_creator_monthly", TotalCount: 0, Quantity: 1},
		{ProviderAccountRef: "acc_test_creator", AccountScope: "connected", PlanID: "plan_creator_monthly", TotalCount: 12, Quantity: 0},
		{ProviderAccountRef: "acc_test_creator", AccountScope: "connected", PlanID: "plan creator", TotalCount: 12, Quantity: 1},
		{ProviderAccountRef: "acc_test_creator", AccountScope: "connected", PlanID: "plan_creator_monthly", TotalCount: 12, Quantity: 1, StartAt: 200, ExpireBy: 100},
	}
	for _, request := range cases {
		if _, err := testClient(t, server).CreateSubscription(context.Background(), request); !errors.Is(err, ErrInvalidOrderRequest) {
			t.Fatalf("request %#v error = %v", request, err)
		}
	}
	if called {
		t.Fatal("invalid subscription request reached provider")
	}
}

func TestCreateSubscriptionRejectsDifferentProviderPlan(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(response, `{"entity":"subscription","id":"sub_123","plan_id":"plan_other","status":"created"}`)
	}))
	defer server.Close()

	_, err := testClient(t, server).CreateSubscription(context.Background(), CreateSubscriptionRequest{
		ProviderAccountRef: "acc_test_creator",
		AccountScope:       "connected",
		PlanID:             "plan_creator_monthly",
		TotalCount:         12,
		Quantity:           1,
	})
	if !errors.Is(err, ErrProviderResponse) {
		t.Fatalf("error = %v, want provider response mismatch", err)
	}
}

func TestCreatePlatformSubscriptionOmitsConnectedAccountHeader(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("X-Razorpay-Account") != "" {
			t.Fatalf("platform subscription must not use connected-account routing: %q", request.Header.Get("X-Razorpay-Account"))
		}
		_, _ = io.WriteString(response, `{"entity":"subscription","id":"sub_platform_123","plan_id":"plan_creator_monthly","status":"created"}`)
	}))
	defer server.Close()

	subscription, err := testClient(t, server).CreateSubscription(context.Background(), CreateSubscriptionRequest{
		ProviderAccountRef: "acc_bharatstudio_platform",
		AccountScope:       "platform",
		PlanID:             "plan_creator_monthly",
		TotalCount:         12,
		Quantity:           1,
	})
	if err != nil || subscription.ID != "sub_platform_123" {
		t.Fatalf("subscription=%#v err=%v", subscription, err)
	}
}

func TestCreateOrderRejectsInvalidRequestsBeforeNetwork(t *testing.T) {
	called := false
	server := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) { called = true }))
	defer server.Close()

	cases := []CreateOrderRequest{
		{AmountPaise: 999, Currency: "INR", Receipt: "tip_1"},
		{AmountPaise: 1000, Currency: "USD", Receipt: "tip_1"},
		{AmountPaise: 1000, Currency: "INR", Receipt: strings.Repeat("x", 41)},
		{AmountPaise: 1000, Currency: "INR", Receipt: "tip_1", Notes: map[string]string{"bad": strings.Repeat("x", 257)}},
	}
	for _, request := range cases {
		if _, err := testClient(t, server).CreateOrder(context.Background(), request); !errors.Is(err, ErrInvalidOrderRequest) {
			t.Fatalf("request %#v error = %v", request, err)
		}
	}
	if called {
		t.Fatal("invalid order request reached provider")
	}
}

func TestProviderFailureIsRetryableWithoutLeakingBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.WriteHeader(http.StatusBadGateway)
		_, _ = io.WriteString(response, `{"error":{"description":"test_secret must never escape"}}`)
	}))
	defer server.Close()

	_, err := testClient(t, server).CreateOrder(context.Background(), CreateOrderRequest{
		AmountPaise:         1000,
		Currency:            "INR",
		Receipt:             "tip_1",
		ConnectedAccountRef: "acc_test_creator",
	})
	var providerErr *ProviderError
	if !errors.As(err, &providerErr) || !providerErr.Retryable || providerErr.StatusCode != http.StatusBadGateway {
		t.Fatalf("unexpected provider error: %#v", err)
	}
	if strings.Contains(err.Error(), "test_secret") {
		t.Fatalf("provider body leaked into error: %v", err)
	}
}

func TestProviderResponseMismatchIsRejected(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		_, _ = io.WriteString(response, `{"entity":"order","id":"order_123","amount":2000,"amount_due":2000,"currency":"INR","receipt":"different","status":"created"}`)
	}))
	defer server.Close()

	_, err := testClient(t, server).CreateOrder(context.Background(), CreateOrderRequest{
		AmountPaise:         1000,
		Currency:            "INR",
		Receipt:             "tip_1",
		ConnectedAccountRef: "acc_test_creator",
	})
	if !errors.Is(err, ErrOrderMismatch) {
		t.Fatalf("error = %v", err)
	}
}

func TestNewClientFailsClosedForNonTLSOrMissingCredentials(t *testing.T) {
	if _, err := NewRazorpayClient("http://localhost:8080", "key", "secret", nil); !errors.Is(err, ErrInvalidClientConfig) {
		t.Fatalf("http endpoint error = %v", err)
	}
	if _, err := NewRazorpayClient("https://api.razorpay.com", "", "secret", nil); !errors.Is(err, ErrInvalidClientConfig) {
		t.Fatalf("missing key error = %v", err)
	}
}
