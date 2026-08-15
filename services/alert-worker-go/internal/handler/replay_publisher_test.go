package handler

import (
	"context"
	"testing"

	"github.com/bharatstudio/bharatstudio-alerts/services/alert-worker-go/internal/store"
)

func TestDurableReplayPublisherDoesNotSendPreCompletionWakeup(t *testing.T) {
	publisher := NewDurableReplayPublisher()
	if err := publisher.Publish(context.Background(), store.ClaimedDelivery{DeliveryID: "delivery-1", EventID: "event-1"}); err != nil {
		t.Fatalf("Publish() error = %v", err)
	}
}
