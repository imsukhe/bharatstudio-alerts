//go:build integration

package reconcile

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/bharatstudio/bharatstudio-alerts/services/payment-webhook-go/internal/db"
)

// TestSQLStoreListsAccountScopedCandidatesAgainstPostgres exercises the
// adapter against the final 0034/0035 function signatures. The account
// reference is part of the immutable candidate returned to the provider
// client; it must never be reconstructed from process-wide configuration.
func TestSQLStoreListsAccountScopedCandidatesAgainstPostgres(t *testing.T) {
	dsn := os.Getenv("BSA_PAYMENT_SQL_DSN")
	if dsn == "" {
		t.Skip("BSA_PAYMENT_SQL_DSN is required for the disposable PostgreSQL integration test")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	database, err := db.Open(ctx, db.Config{DSN: dsn, MaxOpenConns: 2, MaxIdleConns: 2})
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer database.Close()

	store, err := NewSQLStore(database)
	if err != nil {
		t.Fatalf("create reconciliation SQL store: %v", err)
	}

	const (
		intentID       = "00000000-0000-4000-8000-000000000224"
		paymentID      = "00000000-0000-4000-8000-000000000226"
		refundID       = "00000000-0000-4000-8000-000000000225"
		accountRef     = "acct_synthetic_a"
		providerOrder  = "order_reconcile_adapter_1"
		providerPayID  = "pay_reconcile_adapter_1"
		providerRefund = "rfnd_reconcile_adapter_1"
	)

	_, err = database.ExecContext(ctx, `
insert into payment_order_intents
  (id, channel_id, payment_account_id, provider, environment,
   connected_account_ref, idempotency_key, provider_receipt,
   provider_order_id, gross_amount_paise, currency, donor_display_name,
   donor_message, alert_consent, status, expires_at, created_at, updated_at)
values
  ($1::uuid, '00000000-0000-4000-8000-000000000011',
   '00000000-0000-4000-8000-000000000041', 'razorpay', 'test', $2,
   'reconcile-adapter-idempotency-1', 'reconcile-adapter-receipt-1',
   $3, 2500, 'INR', 'Reconcile donor', 'adapter candidate', true,
   'provider_created', current_timestamp + interval '15 minutes',
   current_timestamp, current_timestamp)`, intentID, accountRef, providerOrder)
	if err != nil {
		t.Fatalf("insert reconciliation intent fixture: %v", err)
	}

	_, err = database.ExecContext(ctx, `
insert into payments
  (id, channel_id, provider, provider_payment_id, provider_order_id,
   gross_amount_paise, currency, status, environment, connected_account_ref,
   created_at, updated_at)
values
  ($1::uuid, '00000000-0000-4000-8000-000000000011', 'razorpay', $2, $3,
   2500, 'INR', 'captured', 'test', $4, current_timestamp, current_timestamp)`,
		paymentID, providerPayID, providerOrder, accountRef)
	if err != nil {
		t.Fatalf("insert reconciliation payment fixture: %v", err)
	}
	_, err = database.ExecContext(ctx, `
insert into refunds
  (id, payment_id, provider_refund_id, amount_paise, status, created_at, updated_at)
values ($1::uuid, $2::uuid, $3, 500, 'requested', current_timestamp, current_timestamp)`,
		refundID, paymentID, providerRefund)
	if err != nil {
		t.Fatalf("insert reconciliation refund fixture: %v", err)
	}

	candidates, err := store.ListCandidates(ctx, 20)
	if err != nil {
		t.Fatalf("list payment reconciliation candidates: %v", err)
	}
	var foundPayment bool
	for _, candidate := range candidates {
		if candidate.IntentID == intentID {
			foundPayment = true
			if candidate.ConnectedAccountRef != accountRef || candidate.ProviderOrderID != providerOrder || candidate.AmountPaise != 2500 || candidate.Currency != "INR" {
				t.Fatalf("payment candidate lost immutable account/order fields: %+v", candidate)
			}
		}
	}
	if !foundPayment {
		t.Fatalf("payment candidate %s was not returned: %+v", intentID, candidates)
	}

	refundCandidates, err := store.ListRefundCandidates(ctx, 20)
	if err != nil {
		t.Fatalf("list refund reconciliation candidates: %v", err)
	}
	var foundRefund bool
	for _, candidate := range refundCandidates {
		if candidate.RefundID == refundID {
			foundRefund = true
			if candidate.ConnectedAccountRef != accountRef || candidate.ProviderRefundID != providerRefund || candidate.ProviderPaymentID != providerPayID || candidate.AmountPaise != 500 || candidate.Currency != "INR" {
				t.Fatalf("refund candidate lost immutable account/payment fields: %+v", candidate)
			}
		}
	}
	if !foundRefund {
		t.Fatalf("refund candidate %s was not returned: %+v", refundID, refundCandidates)
	}
}
