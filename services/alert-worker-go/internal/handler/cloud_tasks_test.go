package handler

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/bharatstudio/bharatstudio-alerts/services/alert-worker-go/internal/store"
)

type fakeAuthorizer struct{ err error }

func (a fakeAuthorizer) Authorize(*http.Request) error { return a.err }

type fakeDeliveryStore struct {
	claimed       bool
	claimCalls    int
	retryCalls    int
	completeCalls int
	releaseCalls  int
	claimErr      error
	retryErr      error
	completeErr   error
	completed     bool
}

func (s *fakeDeliveryStore) Claim(_ context.Context, _ string, _ string, _ string, _ int, _ int64, _ string, _ time.Time) (store.ClaimedDelivery, bool, error) {
	s.claimCalls++
	if s.claimErr != nil {
		return store.ClaimedDelivery{}, false, s.claimErr
	}
	return store.ClaimedDelivery{DeliveryID: "delivery-1", EventID: "event-1", OutboxID: "outbox-1", ChannelID: "channel-1", QueueID: "queue-1", TraceID: "trace-1"}, s.claimed, nil
}

func (s *fakeDeliveryStore) Retry(_ context.Context, _, _ string, _ time.Time, _ string) (bool, error) {
	s.retryCalls++
	return s.retryErr == nil, s.retryErr
}

func (s *fakeDeliveryStore) Complete(_ context.Context, _, _, _ string) (store.CompletedDelivery, bool, error) {
	s.completeCalls++
	return store.CompletedDelivery{DeliveryID: "delivery-1", Status: "displayed"}, s.completed, s.completeErr
}

func (s *fakeDeliveryStore) Release(_ context.Context, _, _ string) (store.CompletedDelivery, bool, error) {
	s.releaseCalls++
	return store.CompletedDelivery{DeliveryID: "delivery-1", Status: "ready"}, s.completed, s.completeErr
}

type fakePublisher struct {
	calls int
	err   error
}

func (p *fakePublisher) Publish(context.Context, store.ClaimedDelivery) error {
	p.calls++
	return p.err
}

type fakeNotifier struct {
	calls     int
	channelID string
	eventID   string
	err       error
}

func (n *fakeNotifier) Notify(_ context.Context, channelID, eventID string) error {
	n.calls++
	n.channelID = channelID
	n.eventID = eventID
	return n.err
}

func commandBody(deadline time.Time) string {
	createdAt := deadline.Add(-time.Minute)
	return `{"schemaVersion":"v1","action":"deliver_overlay","eventId":"00000000-0000-4000-8000-000000000001","outboxId":"00000000-0000-4000-8000-000000000002","deliveryId":"00000000-0000-4000-8000-000000000003","attemptNumber":1,"expectedStateVersion":1,"traceId":"trace-1","createdAt":"` + createdAt.UTC().Format(time.RFC3339Nano) + `","deadline":"` + deadline.UTC().Format(time.RFC3339Nano) + `"}`
}

func TestRandomTokenIsUUIDV4ForSQLLeaseBoundary(t *testing.T) {
	token, err := randomToken()
	if err != nil || len(token) != 36 || token[8] != '-' || token[13] != '-' || token[18] != '-' || token[23] != '-' || token[14] != '4' {
		t.Fatalf("token=%q err=%v", token, err)
	}
	if !strings.Contains("89ab", string(token[19])) {
		t.Fatalf("token variant=%q", token)
	}
}

func testHandler(storeValue *fakeDeliveryStore, publisher *fakePublisher, now time.Time) Handler {
	return New(Config{
		Authorizer: fakeAuthorizer{},
		Store:      storeValue,
		Publisher:  publisher,
		Now:        func() time.Time { return now },
		Token:      func() (string, error) { return "lease-1", nil },
	})
}

func TestCloudTaskHandlerClaimsPublishesAndCompletes(t *testing.T) {
	now := time.Date(2026, 8, 14, 10, 0, 0, 0, time.UTC)
	storeValue := &fakeDeliveryStore{claimed: true, completed: true}
	publisher := &fakePublisher{}
	notifier := &fakeNotifier{}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/internal/tasks/alert", strings.NewReader(commandBody(now.Add(time.Minute))))
	handler := testHandler(storeValue, publisher, now)
	handler.config.Notifier = notifier
	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK || publisher.calls != 1 || storeValue.releaseCalls != 1 || notifier.calls != 1 || notifier.channelID != "channel-1" {
		t.Fatalf("status=%d publisher=%d release=%d notify=%d channel=%q", recorder.Code, publisher.calls, storeValue.releaseCalls, notifier.calls, notifier.channelID)
	}
}

func TestCloudTaskHandlerTreatsStaleClaimAsSafeNoOp(t *testing.T) {
	now := time.Date(2026, 8, 14, 10, 0, 0, 0, time.UTC)
	storeValue := &fakeDeliveryStore{}
	publisher := &fakePublisher{}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/internal/tasks/alert", strings.NewReader(commandBody(now.Add(time.Minute))))
	testHandler(storeValue, publisher, now).ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK || publisher.calls != 0 {
		t.Fatalf("status=%d publisher=%d", recorder.Code, publisher.calls)
	}
}

func TestCloudTaskHandlerRetriesPublisherFailure(t *testing.T) {
	now := time.Date(2026, 8, 14, 10, 0, 0, 0, time.UTC)
	storeValue := &fakeDeliveryStore{claimed: true}
	publisher := &fakePublisher{err: errors.New("overlay unavailable")}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/internal/tasks/alert", strings.NewReader(commandBody(now.Add(time.Minute))))
	testHandler(storeValue, publisher, now).ServeHTTP(recorder, request)

	if recorder.Code != http.StatusServiceUnavailable || storeValue.retryCalls != 1 || recorder.Header().Get("Retry-After") != "5" {
		t.Fatalf("status=%d retries=%d retry-after=%q", recorder.Code, storeValue.retryCalls, recorder.Header().Get("Retry-After"))
	}
}

func TestCloudTaskHandlerRetriesWhenReleaseIsNotConfirmed(t *testing.T) {
	now := time.Date(2026, 8, 14, 10, 0, 0, 0, time.UTC)
	storeValue := &fakeDeliveryStore{claimed: true, completed: false}
	publisher := &fakePublisher{}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/internal/tasks/alert", strings.NewReader(commandBody(now.Add(time.Minute))))
	testHandler(storeValue, publisher, now).ServeHTTP(recorder, request)

	if recorder.Code != http.StatusServiceUnavailable || publisher.calls != 1 || storeValue.releaseCalls != 1 || storeValue.retryCalls != 1 {
		t.Fatalf("status=%d publisher=%d release=%d retries=%d", recorder.Code, publisher.calls, storeValue.releaseCalls, storeValue.retryCalls)
	}
}

func TestCloudTaskHandlerRequiresInternalAuthorization(t *testing.T) {
	now := time.Date(2026, 8, 14, 10, 0, 0, 0, time.UTC)
	storeValue := &fakeDeliveryStore{claimed: true}
	publisher := &fakePublisher{}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/internal/tasks/alert", strings.NewReader(commandBody(now.Add(time.Minute))))
	handler := New(Config{Authorizer: fakeAuthorizer{err: errors.New("bad oidc")}, Store: storeValue, Publisher: publisher, Now: func() time.Time { return now }})
	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusUnauthorized || storeValue.claimCalls != 0 {
		t.Fatalf("status=%d claims=%d", recorder.Code, storeValue.claimCalls)
	}
}

func TestCloudTaskHandlerRejectsNonPost(t *testing.T) {
	now := time.Date(2026, 8, 14, 10, 0, 0, 0, time.UTC)
	storeValue := &fakeDeliveryStore{claimed: true}
	publisher := &fakePublisher{}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/internal/tasks/alert", nil)
	testHandler(storeValue, publisher, now).ServeHTTP(recorder, request)

	if recorder.Code != http.StatusMethodNotAllowed || recorder.Header().Get("Allow") != http.MethodPost || storeValue.claimCalls != 0 || publisher.calls != 0 {
		t.Fatalf("status=%d allow=%q claims=%d publishes=%d", recorder.Code, recorder.Header().Get("Allow"), storeValue.claimCalls, publisher.calls)
	}
}

func TestCloudTaskHandlerRejectsUnknownCommandFields(t *testing.T) {
	now := time.Date(2026, 8, 14, 10, 0, 0, 0, time.UTC)
	storeValue := &fakeDeliveryStore{}
	publisher := &fakePublisher{}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/internal/tasks/alert", strings.NewReader(commandBody(now.Add(time.Minute))[:len(commandBody(now.Add(time.Minute)))-1]+`,"unexpected":true}`))
	testHandler(storeValue, publisher, now).ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadRequest || storeValue.claimCalls != 0 {
		t.Fatalf("status=%d claims=%d", recorder.Code, storeValue.claimCalls)
	}
}

func TestCloudTaskHandlerRejectsTrailingContentAndOversizedBody(t *testing.T) {
	now := time.Date(2026, 8, 14, 10, 0, 0, 0, time.UTC)
	storeValue := &fakeDeliveryStore{}
	publisher := &fakePublisher{}
	handler := New(Config{Authorizer: fakeAuthorizer{}, Store: storeValue, Publisher: publisher, Now: func() time.Time { return now }, BodyLimit: 8})

	trailing := httptest.NewRecorder()
	trailingRequest := httptest.NewRequest(http.MethodPost, "/internal/tasks/alert", strings.NewReader(`{} {}`))
	handler.ServeHTTP(trailing, trailingRequest)
	if trailing.Code != http.StatusBadRequest {
		t.Fatalf("trailing status=%d", trailing.Code)
	}

	oversized := httptest.NewRecorder()
	oversizedRequest := httptest.NewRequest(http.MethodPost, "/internal/tasks/alert", strings.NewReader("123456789"))
	handler.ServeHTTP(oversized, oversizedRequest)
	if oversized.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized status=%d", oversized.Code)
	}
}
