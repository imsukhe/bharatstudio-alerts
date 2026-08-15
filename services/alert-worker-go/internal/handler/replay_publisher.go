package handler

import (
	"context"

	"github.com/bharatstudio/bharatstudio-alerts/services/alert-worker-go/internal/store"
)

// DurableReplayPublisher is the durable publication boundary. The delivery
// already exists in PostgreSQL before this method is called; the handler
// releases the publication lease and sends one best-effort wake-up afterwards.
// Keeping this method a no-op prevents a pre-release notification from being
// sent twice or from turning a harmless notification failure into task replay.
type DurableReplayPublisher struct{}

func NewDurableReplayPublisher() DurableReplayPublisher {
	return DurableReplayPublisher{}
}

func (p DurableReplayPublisher) Publish(_ context.Context, _ store.ClaimedDelivery) error {
	return nil
}

var _ Publisher = DurableReplayPublisher{}
