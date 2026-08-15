package reconcile

import (
	"context"
	"errors"
	"strings"

	"github.com/bharatstudio/bharatstudio-alerts/services/payment-webhook-go/internal/provider"
)

type RefundCandidate struct {
	RefundID            string
	ConnectedAccountRef string
	ProviderRefundID    string
	ProviderPaymentID   string
	AmountPaise         int64
	Currency            string
	Status              string
}

type RefundStore interface {
	ListRefundCandidates(context.Context, int) ([]RefundCandidate, error)
	ApplyRefundReconciliation(context.Context, RefundCandidate, provider.Refund) error
}

type RefundProvider interface {
	FetchRefundForAccount(context.Context, string, string) (provider.Refund, error)
}

type RefundSummary struct {
	Candidates   int `json:"candidates"`
	Updated      int `json:"updated"`
	Noop         int `json:"noop"`
	Retryable    int `json:"retryable"`
	ManualReview int `json:"manualReview"`
}

type RefundRunner struct {
	Store    RefundStore
	Provider RefundProvider
}

func (r RefundRunner) RunOnce(ctx context.Context, limit int) (RefundSummary, error) {
	var summary RefundSummary
	if r.Store == nil || r.Provider == nil {
		return summary, errors.New("refund reconciliation dependencies are not configured")
	}
	candidates, err := r.Store.ListRefundCandidates(ctx, limit)
	if err != nil {
		return summary, err
	}
	summary.Candidates = len(candidates)
	partial := false
	for _, candidate := range candidates {
		refund, fetchErr := r.Provider.FetchRefundForAccount(ctx, candidate.ConnectedAccountRef, candidate.ProviderRefundID)
		if fetchErr != nil {
			summary.Retryable++
			partial = true
			continue
		}
		if refund.ID != candidate.ProviderRefundID || refund.PaymentID != candidate.ProviderPaymentID || refund.AmountPaise != candidate.AmountPaise || refund.Currency != candidate.Currency {
			summary.ManualReview++
			partial = true
			continue
		}
		status := strings.ToLower(strings.TrimSpace(refund.Status))
		if status == "pending" || status == "created" {
			summary.Noop++
			continue
		}
		if status != "processed" && status != "failed" && status != "reversed" {
			summary.ManualReview++
			partial = true
			continue
		}
		if err := r.Store.ApplyRefundReconciliation(ctx, candidate, refund); err != nil {
			summary.Retryable++
			partial = true
			continue
		}
		summary.Updated++
	}
	if partial {
		return summary, ErrPartialRun
	}
	return summary, nil
}
