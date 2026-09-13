package provider

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestCreateUpiQrForAccountSendsServerOwnedRequestAndParsesQr(t *testing.T) {
	closeBy := time.Now().Add(10 * time.Minute)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/v1/payments/qr_codes" {
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
		if body["type"] != "upi_qr" || body["usage"] != "single_use" || body["fixed_amount"] != true || body["payment_amount"] != float64(5000) {
			t.Fatalf("unexpected request body: %#v", body)
		}
		if _, ok := body["notes"].(map[string]any)["bsa_intent_id"]; !ok {
			t.Fatalf("expected bsa_intent_id note, got: %#v", body["notes"])
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(response, `{"entity":"qr_code","id":"qr_123","type":"upi_qr","status":"active","image_url":"https://rzp.io/i/qr_123.png","payment_amount":5000,"fixed_amount":true,"close_by":1700000600}`)
	}))
	defer server.Close()

	qrCode, err := testClient(t, server).CreateUpiQrForAccount(context.Background(), CreateQrRequest{
		AmountPaise:          5000,
		Currency:             "INR",
		Receipt:              "tip_123",
		ConnectedAccountRef:  "acc_test_creator",
		CloseBy:              closeBy,
		Notes:                map[string]string{"bsa_intent_id": "intent_123"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if qrCode.ID != "qr_123" || qrCode.ImageURL != "https://rzp.io/i/qr_123.png" || qrCode.Status != "active" || qrCode.PaymentAmt != 5000 {
		t.Fatalf("unexpected qr code: %#v", qrCode)
	}
}

func TestCreateUpiQrForAccountRejectsInvalidRequest(t *testing.T) {
	client := testClient(t, httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("provider must not be called for a locally invalid request")
	})))
	defer func() {}()

	_, err := client.CreateUpiQrForAccount(context.Background(), CreateQrRequest{
		AmountPaise:         500, // below the ten-rupee floor
		Currency:            "INR",
		Receipt:             "tip_123",
		ConnectedAccountRef: "acc_test_creator",
		CloseBy:             time.Now().Add(time.Minute),
	})
	if err == nil {
		t.Fatal("expected an error for an amount below the floor")
	}
}

func TestCreateUpiQrForAccountRejectsProviderAmountMismatch(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(response, `{"entity":"qr_code","id":"qr_123","type":"upi_qr","status":"active","image_url":"https://rzp.io/i/qr_123.png","payment_amount":9999,"fixed_amount":true,"close_by":1700000600}`)
	}))
	defer server.Close()

	_, err := testClient(t, server).CreateUpiQrForAccount(context.Background(), CreateQrRequest{
		AmountPaise:         5000,
		Currency:            "INR",
		Receipt:             "tip_123",
		ConnectedAccountRef: "acc_test_creator",
		CloseBy:             time.Now().Add(10 * time.Minute),
	})
	if err != ErrQrProviderMismatch {
		t.Fatalf("expected ErrQrProviderMismatch, got: %v", err)
	}
}

func TestCreateUpiQrForAccountRejectsNonHttpsImageUrl(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(response, `{"entity":"qr_code","id":"qr_123","type":"upi_qr","status":"active","image_url":"http://rzp.io/i/qr_123.png","payment_amount":5000,"fixed_amount":true,"close_by":1700000600}`)
	}))
	defer server.Close()

	_, err := testClient(t, server).CreateUpiQrForAccount(context.Background(), CreateQrRequest{
		AmountPaise:         5000,
		Currency:            "INR",
		Receipt:             "tip_123",
		ConnectedAccountRef: "acc_test_creator",
		CloseBy:             time.Now().Add(10 * time.Minute),
	})
	if err == nil {
		t.Fatal("expected an error for a non-https image url")
	}
}

func TestCreateUpiQrForAccountTreatsServerErrorAsRetryable(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	_, err := testClient(t, server).CreateUpiQrForAccount(context.Background(), CreateQrRequest{
		AmountPaise:         5000,
		Currency:            "INR",
		Receipt:             "tip_123",
		ConnectedAccountRef: "acc_test_creator",
		CloseBy:             time.Now().Add(10 * time.Minute),
	})
	var providerErr *ProviderError
	if err == nil {
		t.Fatal("expected a provider error")
	}
	if !asProviderError(err, &providerErr) || !providerErr.Retryable {
		t.Fatalf("expected a retryable provider error, got: %v", err)
	}
}

func asProviderError(err error, target **ProviderError) bool {
	pe, ok := err.(*ProviderError)
	if !ok {
		return false
	}
	*target = pe
	return true
}
