package webhook

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
)

var (
	ErrMalformedPayload = errors.New("malformed razorpay payload")
	ErrUnsupportedEvent = errors.New("unsupported razorpay event")
	ErrMissingEntity    = errors.New("missing razorpay event entity")
)

// Event is the minimal normalized projection needed by the payment state
// machine. The original signed body remains the immutable evidence; this
// projection is never used to recalculate the signature.
type Event struct {
	Name         string
	AccountID    string
	CreatedAt    int64
	EntityType   string
	EntityID     string
	PaymentID    string
	OrderID      string
	AmountPaise  int64
	Currency     string
	Status       string
	RefundAmount int64
	PlanID       string
	CurrentStart int64
	CurrentEnd   int64
	ChargeAt     int64
}

type payloadEnvelope struct {
	Event     string                                      `json:"event"`
	AccountID string                                      `json:"account_id"`
	CreatedAt int64                                       `json:"created_at"`
	Payload   map[string]struct{ Entity json.RawMessage } `json:"payload"`
}

type entityProjection struct {
	Entity       string `json:"entity"`
	ID           string `json:"id"`
	PaymentID    string `json:"payment_id"`
	OrderID      string `json:"order_id"`
	PlanID       string `json:"plan_id"`
	Amount       int64  `json:"amount"`
	Currency     string `json:"currency"`
	Status       string `json:"status"`
	CurrentStart int64  `json:"current_start"`
	CurrentEnd   int64  `json:"current_end"`
	ChargeAt     int64  `json:"charge_at"`
}

func ParseEvent(rawBody []byte) (Event, error) {
	decoder := json.NewDecoder(bytes.NewReader(rawBody))
	var envelope payloadEnvelope
	if err := decoder.Decode(&envelope); err != nil {
		return Event{}, ErrMalformedPayload
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return Event{}, ErrMalformedPayload
	}
	if strings.TrimSpace(envelope.Event) == "" {
		return Event{}, ErrMalformedPayload
	}

	entityType, payloadKey := eventEntity(envelope.Event)
	if entityType == "" {
		return Event{}, ErrUnsupportedEvent
	}
	payload, ok := envelope.Payload[payloadKey]
	if !ok || len(payload.Entity) == 0 {
		return Event{}, ErrMissingEntity
	}
	var entity entityProjection
	if err := json.Unmarshal(payload.Entity, &entity); err != nil || entity.ID == "" {
		return Event{}, ErrMissingEntity
	}
	if entity.Entity != "" && entity.Entity != entityType && !(entityType == "payment" && entity.Entity == "order") {
		return Event{}, ErrMissingEntity
	}

	event := Event{
		Name:         envelope.Event,
		AccountID:    envelope.AccountID,
		CreatedAt:    envelope.CreatedAt,
		EntityType:   entityType,
		EntityID:     entity.ID,
		PaymentID:    entity.PaymentID,
		OrderID:      entity.OrderID,
		AmountPaise:  entity.Amount,
		Currency:     entity.Currency,
		Status:       entity.Status,
		PlanID:       entity.PlanID,
		CurrentStart: entity.CurrentStart,
		CurrentEnd:   entity.CurrentEnd,
		ChargeAt:     entity.ChargeAt,
	}
	if entityType == "payment" {
		event.PaymentID = entity.ID
	}
	if entityType == "refund" {
		event.RefundAmount = entity.Amount
	}
	return event, nil
}

func eventEntity(eventName string) (entityType, payloadKey string) {
	switch {
	case strings.HasPrefix(eventName, "payment.dispute."):
		return "dispute", "dispute"
	case strings.HasPrefix(eventName, "payment.") || eventName == "order.paid":
		return "payment", "payment"
	case strings.HasPrefix(eventName, "refund."):
		return "refund", "refund"
	case strings.HasPrefix(eventName, "subscription."):
		return "subscription", "subscription"
	case strings.HasPrefix(eventName, "dispute."):
		return "dispute", "dispute"
	default:
		return "", ""
	}
}
