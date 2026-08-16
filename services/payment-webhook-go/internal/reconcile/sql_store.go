package reconcile

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/bharatstudio/bharatstudio-alerts/services/payment-webhook-go/internal/provider"
)

type SQLStore struct {
	db *sql.DB
}

func NewSQLStore(db *sql.DB) (SQLStore, error) {
	if db == nil {
		return SQLStore{}, errors.New("reconciliation database is not configured")
	}
	return SQLStore{db: db}, nil
}

func (s SQLStore) ListCandidates(ctx context.Context, limit int) ([]Candidate, error) {
	rows, err := s.db.QueryContext(ctx, `
select intent_id::text, connected_account_ref, provider_order_id, provider_receipt,
       amount_paise, currency, status, expires_at
  from app_private.list_payment_reconciliation_candidates($1::integer)`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var candidates []Candidate
	for rows.Next() {
		var candidate Candidate
		if err := rows.Scan(&candidate.IntentID, &candidate.ConnectedAccountRef, &candidate.ProviderOrderID, &candidate.ProviderReceipt, &candidate.AmountPaise, &candidate.Currency, &candidate.Status, &candidate.ExpiresAt); err != nil {
			return nil, err
		}
		candidates = append(candidates, candidate)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return candidates, nil
}

func (s SQLStore) ExpireLocalIntent(ctx context.Context, intentID, providerStatus string) (bool, error) {
	var returnedID string
	err := s.db.QueryRowContext(ctx, `
select intent_id::text
  from app_private.expire_payment_order_intent($1::uuid, $2::text)`, intentID, providerStatus).Scan(&returnedID)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return returnedID == intentID, nil
}

func (s SQLStore) QueuePaymentRecovery(ctx context.Context, intentID, providerOrderID string, observedAt time.Time) (bool, error) {
	var workItemID string
	err := s.db.QueryRowContext(ctx, `
select work_item_id::text
  from app_private.enqueue_payment_recovery($1::uuid, $2::text, $3::timestamptz)`, intentID, providerOrderID, observedAt).Scan(&workItemID)
	if err != nil {
		return false, err
	}
	return workItemID != "", nil
}

func (s SQLStore) QuarantinePayment(ctx context.Context, intentID, reason string) (bool, error) {
	var quarantined bool
	err := s.db.QueryRowContext(ctx, `
select app_private.quarantine_payment_reconciliation($1::uuid, $2::text)`, intentID, reason).Scan(&quarantined)
	return quarantined, err
}

func (s SQLStore) ListRefundCandidates(ctx context.Context, limit int) ([]RefundCandidate, error) {
	rows, err := s.db.QueryContext(ctx, `
select refund_id::text, connected_account_ref, provider_refund_id, provider_payment_id, amount_paise, currency, status
  from app_private.list_refund_reconciliation_candidates($1::integer)`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var candidates []RefundCandidate
	for rows.Next() {
		var candidate RefundCandidate
		if err := rows.Scan(&candidate.RefundID, &candidate.ConnectedAccountRef, &candidate.ProviderRefundID, &candidate.ProviderPaymentID, &candidate.AmountPaise, &candidate.Currency, &candidate.Status); err != nil {
			return nil, err
		}
		candidates = append(candidates, candidate)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return candidates, nil
}

func (s SQLStore) ApplyRefundReconciliation(ctx context.Context, candidate RefundCandidate, refund provider.Refund) error {
	var refundID, refundStatus, paymentStatus string
	err := s.db.QueryRowContext(ctx, `
select refund_id::text, refund_status, payment_status
  from app_private.apply_refund_reconciliation($1::uuid, $2::text, $3::text, $4::bigint, $5::text, $6::text)`, candidate.RefundID, candidate.ProviderRefundID, candidate.ProviderPaymentID, candidate.AmountPaise, candidate.Currency, refund.Status).Scan(&refundID, &refundStatus, &paymentStatus)
	if err != nil {
		return err
	}
	if refundID != candidate.RefundID || refundStatus == "" || paymentStatus == "" {
		return errors.New("refund reconciliation returned invalid state")
	}
	return nil
}

func (s SQLStore) QuarantineRefund(ctx context.Context, refundID, reason string) (bool, error) {
	var quarantined bool
	err := s.db.QueryRowContext(ctx, `
select app_private.quarantine_refund_reconciliation($1::uuid, $2::text)`, refundID, reason).Scan(&quarantined)
	return quarantined, err
}
