// Package reconcile contains the provider-status reconciliation policy.
// It deliberately does not mark a payment paid: a paid Razorpay order still
// requires payment-level evidence before the financial webhook function can
// create a payment or alert.
package reconcile

import (
	"errors"
	"strings"
	"time"

	"github.com/bharatstudio/bharatstudio-alerts/services/payment-webhook-go/internal/provider"
)

type Action string

const (
	ActionNoop                 Action = "noop"
	ActionExpireLocalIntent    Action = "expire_local_intent"
	ActionQueuePaymentRecovery Action = "queue_payment_recovery"
	ActionRetry                Action = "retry"
	ActionManualReview         Action = "manual_review"
)

var (
	ErrInvalidCandidate = errors.New("invalid reconciliation candidate")
	ErrOrderMismatch    = errors.New("reconciliation order does not match local intent")
	ErrUnsupportedState = errors.New("unsupported provider order state")
)

// Candidate is the immutable local evidence needed to compare a provider
// order. It comes from payment_order_intents; it is not constructed from a
// provider response.
type Candidate struct {
	IntentID            string
	ConnectedAccountRef string
	ProviderOrderID     string
	ProviderReceipt     string
	AmountPaise         int64
	Currency            string
	Status              string
	ExpiresAt           time.Time
}

type Decision struct {
	IntentID        string
	ProviderOrderID string
	ProviderStatus  string
	Action          Action
	Reason          string
}

// Evaluate compares one fetched Razorpay order with the local intent. A
// provider "paid" order only queues a recovery item; it never changes local
// financial state by itself. Payment-level evidence must still be fetched or
// received through the verified webhook path.
func Evaluate(candidate Candidate, order provider.Order, now time.Time) (Decision, error) {
	decision := Decision{
		IntentID:        candidate.IntentID,
		ProviderOrderID: candidate.ProviderOrderID,
		ProviderStatus:  strings.ToLower(strings.TrimSpace(order.Status)),
	}
	if candidate.IntentID == "" || candidate.ProviderOrderID == "" || candidate.AmountPaise < providerMinimumAmountPaise || candidate.Currency != "INR" || candidate.ExpiresAt.IsZero() {
		return decision, ErrInvalidCandidate
	}
	if order.ID != candidate.ProviderOrderID || order.Entity != "order" || order.AmountPaise != candidate.AmountPaise || order.Currency != candidate.Currency {
		return decision, ErrOrderMismatch
	}
	// Razorpay may omit receipt on a fetched order. If it returns one, it must
	// match the local immutable receipt.
	if order.Receipt != "" && order.Receipt != candidate.ProviderReceipt {
		return decision, ErrOrderMismatch
	}
	if order.AmountPaid < 0 || order.AmountPaid > candidate.AmountPaise || order.AmountDue < 0 || order.AmountDue > candidate.AmountPaise {
		return decision, ErrOrderMismatch
	}

	switch decision.ProviderStatus {
	case "paid":
		if order.AmountPaid != candidate.AmountPaise || order.AmountDue != 0 {
			return decision, ErrOrderMismatch
		}
		decision.Action = ActionQueuePaymentRecovery
		decision.Reason = "provider_order_paid_without_verified_payment_webhook"
		return decision, nil
	case "created", "attempted":
		if now.IsZero() {
			now = time.Now()
		}
		if !now.Before(candidate.ExpiresAt) {
			decision.Action = ActionExpireLocalIntent
			decision.Reason = "provider_order_unpaid_after_local_expiry"
			return decision, nil
		}
		decision.Action = ActionNoop
		decision.Reason = "provider_order_still_open"
		return decision, nil
	default:
		decision.Action = ActionManualReview
		decision.Reason = "provider_order_status_not_supported_by_v1"
		return decision, ErrUnsupportedState
	}
}

// This mirrors the platform's ₹10 floor without exporting provider adapter
// internals into the reconciliation package.
const providerMinimumAmountPaise int64 = 1000
