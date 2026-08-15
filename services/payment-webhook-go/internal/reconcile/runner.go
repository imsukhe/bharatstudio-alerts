package reconcile

import (
	"context"
	"errors"
	"time"

	"github.com/bharatstudio/bharatstudio-alerts/services/payment-webhook-go/internal/provider"
)

var ErrPartialRun = errors.New("reconciliation run completed with retryable or review items")

type CandidateStore interface {
	ListCandidates(context.Context, int) ([]Candidate, error)
	ExpireLocalIntent(context.Context, string, string) (bool, error)
	QueuePaymentRecovery(context.Context, string, string, time.Time) (bool, error)
}

type OrdersClient interface {
	FetchOrderForAccount(context.Context, string, string) (provider.Order, error)
}

type PaymentRecoveryProvider interface {
	FetchOrderPaymentsForAccount(context.Context, string, string) ([]provider.Payment, error)
}

type PaymentRecoveryStore interface {
	PersistRecoveredPayment(context.Context, Candidate, provider.Payment) (bool, error)
	CompletePaymentRecovery(context.Context, string) error
}

type Summary struct {
	Candidates     int `json:"candidates"`
	Noop           int `json:"noop"`
	Expired        int `json:"expired"`
	RecoveryQueued int `json:"recoveryQueued"`
	Recovered      int `json:"recovered"`
	Retryable      int `json:"retryable"`
	ManualReview   int `json:"manualReview"`
}

type Runner struct {
	Store            CandidateStore
	Provider         OrdersClient
	RecoveryProvider PaymentRecoveryProvider
	RecoveryStore    PaymentRecoveryStore
	Now              func() time.Time
}

func (r Runner) RunOnce(ctx context.Context, limit int) (Summary, error) {
	var summary Summary
	if r.Store == nil || r.Provider == nil {
		return summary, errors.New("reconciliation dependencies are not configured")
	}
	now := time.Now()
	if r.Now != nil {
		now = r.Now()
	}
	candidates, err := r.Store.ListCandidates(ctx, limit)
	if err != nil {
		return summary, err
	}
	summary.Candidates = len(candidates)
	partial := false
	for _, candidate := range candidates {
		order, fetchErr := r.Provider.FetchOrderForAccount(ctx, candidate.ConnectedAccountRef, candidate.ProviderOrderID)
		if fetchErr != nil {
			summary.Retryable++
			partial = true
			continue
		}
		decision, decisionErr := Evaluate(candidate, order, now)
		if decisionErr != nil {
			summary.ManualReview++
			partial = true
			continue
		}
		switch decision.Action {
		case ActionNoop:
			summary.Noop++
		case ActionExpireLocalIntent:
			changed, err := r.Store.ExpireLocalIntent(ctx, candidate.IntentID, decision.ProviderStatus)
			if err != nil {
				summary.Retryable++
				partial = true
			} else if changed {
				summary.Expired++
			} else {
				// A verified webhook may have won the race. No mutation is
				// needed and the already-paid state remains authoritative.
				summary.Noop++
			}
		case ActionQueuePaymentRecovery:
			queued, err := r.Store.QueuePaymentRecovery(ctx, candidate.IntentID, candidate.ProviderOrderID, now)
			if err != nil {
				summary.Retryable++
				partial = true
			} else if queued {
				summary.RecoveryQueued++
			} else {
				summary.Noop++
			}
			if r.RecoveryProvider != nil && r.RecoveryStore != nil {
				payments, fetchErr := r.RecoveryProvider.FetchOrderPaymentsForAccount(ctx, candidate.ConnectedAccountRef, candidate.ProviderOrderID)
				if fetchErr != nil {
					summary.Retryable++
					partial = true
					continue
				}
				var captured *provider.Payment
				for index := range payments {
					payment := payments[index]
					if payment.Status == "captured" && payment.OrderID == candidate.ProviderOrderID && payment.AmountPaise == candidate.AmountPaise && payment.Currency == candidate.Currency {
						captured = &payment
						break
					}
				}
				if captured == nil {
					summary.Retryable++
					partial = true
					continue
				}
				if _, persistErr := r.RecoveryStore.PersistRecoveredPayment(ctx, candidate, *captured); persistErr != nil {
					summary.Retryable++
					partial = true
					continue
				}
				if completeErr := r.RecoveryStore.CompletePaymentRecovery(ctx, candidate.ProviderOrderID); completeErr != nil {
					summary.Retryable++
					partial = true
					continue
				}
				summary.Recovered++
			}
		default:
			summary.ManualReview++
			partial = true
		}
	}
	if partial {
		return summary, ErrPartialRun
	}
	return summary, nil
}
