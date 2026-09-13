package qr

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type fakeQrAuthorizer struct{ err error }

func (a fakeQrAuthorizer) Authorize(*http.Request) error { return a.err }

type fakeQrCreator struct {
	request Request
	result  Record
	err     error
}

func (s *fakeQrCreator) CreateQr(_ context.Context, request Request) (Record, error) {
	s.request = request
	return s.result, s.err
}

func validQrBody() string {
	return validQrBodyAt(time.Now().Add(5 * time.Minute))
}

func validQrBodyAt(closeBy time.Time) string {
	return fmt.Sprintf(`{"intentId":"00000000-0000-4000-8000-000000000091","channelId":"00000000-0000-4000-8000-000000000011","environment":"test","closeBy":"%s"}`, closeBy.UTC().Format(time.RFC3339))
}

func TestHTTPHandlerRequiresPrivateAuthorization(t *testing.T) {
	service := &fakeQrCreator{}
	handler := HTTPHandler{Authorizer: fakeQrAuthorizer{err: errors.New("bad token")}, Service: service, Environment: "test"}
	request := httptest.NewRequest(http.MethodPost, "/internal/v1/tips/qr", strings.NewReader(validQrBody()))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestHTTPHandlerRejectsWrongMethodAndMissingConfiguration(t *testing.T) {
	handler := HTTPHandler{}
	request := httptest.NewRequest(http.MethodGet, "/internal/v1/tips/qr", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}

	request = httptest.NewRequest(http.MethodPost, "/internal/v1/tips/qr", strings.NewReader(validQrBody()))
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestHTTPHandlerAcceptsValidRequestAndReturnsCreatedQr(t *testing.T) {
	service := &fakeQrCreator{result: Record{ProviderQrID: "qr_prov_1", QrImageURL: "https://rzp.io/i/qr_prov_1.png", CloseBy: time.Unix(1700000600, 0)}}
	handler := HTTPHandler{Authorizer: fakeQrAuthorizer{}, Service: service, Environment: "test"}
	request := httptest.NewRequest(http.MethodPost, "/internal/v1/tips/qr", strings.NewReader(validQrBody()))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if service.request.ChannelID == "" || service.request.Environment != "test" || service.request.IntentID == "" {
		t.Fatalf("service request=%#v", service.request)
	}
	if !strings.Contains(response.Body.String(), "qr_prov_1") || !strings.Contains(response.Body.String(), "https://rzp.io/i/qr_prov_1.png") {
		t.Fatalf("body=%s", response.Body.String())
	}
}

func TestHTTPHandlerRejectsCloseByBeyondBoundaryLifetimeAndPastExpiry(t *testing.T) {
	service := &fakeQrCreator{}
	handler := HTTPHandler{Authorizer: fakeQrAuthorizer{}, Service: service, Environment: "test"}

	request := httptest.NewRequest(http.MethodPost, "/internal/v1/tips/qr", strings.NewReader(validQrBodyAt(time.Now().Add(30*time.Minute))))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("beyond-boundary status=%d body=%s", response.Code, response.Body.String())
	}

	request = httptest.NewRequest(http.MethodPost, "/internal/v1/tips/qr", strings.NewReader(validQrBodyAt(time.Now().Add(-time.Minute))))
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("past-expiry status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestHTTPHandlerMapsServiceErrorsToDistinctStatusCodes(t *testing.T) {
	cases := []struct {
		err    error
		status int
	}{
		{ErrQrCreationInProgress, http.StatusConflict},
		{ErrProviderQrMismatch, http.StatusBadGateway},
		{ErrIntentNotEligible, http.StatusConflict},
		{ErrQrPersistence, http.StatusServiceUnavailable},
	}
	for _, testCase := range cases {
		service := &fakeQrCreator{err: testCase.err}
		handler := HTTPHandler{Authorizer: fakeQrAuthorizer{}, Service: service, Environment: "test"}
		request := httptest.NewRequest(http.MethodPost, "/internal/v1/tips/qr", strings.NewReader(validQrBody()))
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != testCase.status {
			t.Fatalf("err=%v status=%d want=%d body=%s", testCase.err, response.Code, testCase.status, response.Body.String())
		}
	}
}
