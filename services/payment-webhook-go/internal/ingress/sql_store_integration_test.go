//go:build integration

package ingress

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/bharatstudio/bharatstudio-alerts/services/payment-webhook-go/internal/checkout"
	"github.com/bharatstudio/bharatstudio-alerts/services/payment-webhook-go/internal/db"
	"github.com/bharatstudio/bharatstudio-alerts/services/payment-webhook-go/internal/provider"
	"github.com/bharatstudio/bharatstudio-alerts/services/payment-webhook-go/internal/subscription"
	"github.com/bharatstudio/bharatstudio-alerts/services/payment-webhook-go/internal/webhook"
)

func TestSQLStoreRoundTripAgainstPostgres(t *testing.T) {
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

	store, err := NewSQLStore(database, "test")
	if err != nil {
		t.Fatalf("create SQL store: %v", err)
	}

	intent, err := store.CreateIntent(ctx, checkoutIntentRequest())
	if err != nil {
		t.Fatalf("create intent through SQL store: %v", err)
	}
	if intent.ID != "00000000-0000-4000-8000-000000000221" || intent.Status != "provider_pending" || intent.AmountPaise != 7000 {
		t.Fatalf("unexpected intent: %+v", intent)
	}

	claim, acquired, err := store.ClaimProviderCreation(ctx, intent.ID, "00000000-0000-4000-8000-0000000000c1", time.Now().Add(time.Minute))
	if err != nil || !acquired || claim.ID != intent.ID {
		t.Fatalf("claim provider creation: claim=%+v acquired=%t err=%v", claim, acquired, err)
	}
	attached, attachedOK, err := store.AttachProviderOrder(ctx, intent.ID, "00000000-0000-4000-8000-0000000000c1", "order_go_store_1", time.Now())
	if err != nil || !attachedOK || attached.ProviderOrderID != "order_go_store_1" || attached.Status != "provider_created" {
		t.Fatalf("attach provider order: intent=%+v attached=%t err=%v", attached, attachedOK, err)
	}
	if _, err := database.ExecContext(ctx, `
insert into queue_bindings
  (id, channel_id, queue_id, source_type, source_id, allow_duplicates, priority, override_values, created_at)
values
  ('00000000-0000-4000-8000-000000000223',
   '00000000-0000-4000-8000-000000000011',
   '00000000-0000-4000-8000-000000000021',
   'payment', 'pay_go_store_1', true, 30, '{"style":"go-sql-store"}', current_timestamp)`); err != nil {
		t.Fatalf("create synthetic payment binding: %v", err)
	}

	rawBody := []byte(`{"event":"payment.captured","account_id":"acct_synthetic_a","payload":{"payment":{"entity":{"entity":"payment","id":"pay_go_store_1","amount":7000,"currency":"INR","status":"captured","order_id":"order_go_store_1"}}}}`)
	delivery := webhook.Delivery{ProviderEventID: "provider-event-go-store-1", RawBodyHash: "synthetic-go-store-hash"}
	duplicate, err := store.PersistVerified(ctx, delivery, rawBody)
	if err != nil || duplicate {
		t.Fatalf("persist first verified webhook: duplicate=%t err=%v", duplicate, err)
	}
	duplicate, err = store.PersistVerified(ctx, delivery, rawBody)
	if err != nil || !duplicate {
		t.Fatalf("persist duplicate verified webhook: duplicate=%t err=%v", duplicate, err)
	}
	wrongAccountBody := []byte(`{"event":"payment.captured","account_id":"acct_other_creator","payload":{"payment":{"entity":{"entity":"payment","id":"pay_go_store_wrong_account","amount":7000,"currency":"INR","status":"captured","order_id":"order_go_store_1"}}}}`)
	if _, err := store.PersistVerified(ctx, webhook.Delivery{ProviderEventID: "provider-event-go-store-wrong-account-1", RawBodyHash: "synthetic-go-store-wrong-account-hash"}, wrongAccountBody); err == nil {
		t.Fatal("wrong-account webhook was accepted")
	}
	missingAccountBody := []byte(`{"event":"payment.captured","payload":{"payment":{"entity":{"entity":"payment","id":"pay_go_store_missing_account","amount":7000,"currency":"INR","status":"captured","order_id":"order_go_store_1"}}}}`)
	if _, err := store.PersistVerified(ctx, webhook.Delivery{ProviderEventID: "provider-event-go-store-missing-account-1", RawBodyHash: "synthetic-go-store-missing-account-hash"}, missingAccountBody); err == nil {
		t.Fatal("missing-account webhook was accepted")
	}

	disputeBody := []byte(`{"event":"payment.dispute.created","account_id":"acct_synthetic_a","payload":{"dispute":{"entity":{"entity":"dispute","id":"disp_go_store_1","amount":7000,"currency":"INR","status":"open","payment_id":"pay_go_store_1"}}}}`)
	disputeDelivery := webhook.Delivery{ProviderEventID: "provider-event-go-store-dispute-1", RawBodyHash: "synthetic-go-store-dispute-hash"}
	duplicate, err = store.PersistVerified(ctx, disputeDelivery, disputeBody)
	if err != nil || duplicate {
		t.Fatalf("persist first dispute webhook: duplicate=%t err=%v", duplicate, err)
	}
	duplicate, err = store.PersistVerified(ctx, disputeDelivery, disputeBody)
	if err != nil || !duplicate {
		t.Fatalf("persist duplicate dispute webhook: duplicate=%t err=%v", duplicate, err)
	}

	linkResult, err := store.RegisterSubscriptionLink(ctx, "00000000-0000-4000-8000-000000000011", "connected", "acct_synthetic_a", "sub_go_store_1", "plan_creator_monthly", "creator", "monthly", 39900)
	if err != nil || linkResult != "created" {
		t.Fatalf("register subscription link: result=%q err=%v", linkResult, err)
	}
	subscriptionBody := []byte(`{"event":"subscription.activated","account_id":"acct_synthetic_a","payload":{"subscription":{"entity":{"entity":"subscription","id":"sub_go_store_1","plan_id":"plan_creator_monthly","status":"active","current_start":1798761600,"current_end":1830297600,"charge_at":1830297600}}}}`)
	subscriptionDelivery := webhook.Delivery{ProviderEventID: "provider-event-go-store-subscription-1", RawBodyHash: "synthetic-go-store-subscription-hash"}
	duplicate, err = store.PersistVerified(ctx, subscriptionDelivery, subscriptionBody)
	if err != nil || duplicate {
		t.Fatalf("persist first subscription webhook: duplicate=%t err=%v", duplicate, err)
	}
	duplicate, err = store.PersistVerified(ctx, subscriptionDelivery, subscriptionBody)
	if err != nil || !duplicate {
		t.Fatalf("persist duplicate subscription webhook: duplicate=%t err=%v", duplicate, err)
	}
	var subscriptionStatus, subscriptionTier string
	if err := database.QueryRowContext(ctx, `
select status, tier
  from channel_subscriptions
 where provider_subscription_id = 'sub_go_store_1'`).Scan(&subscriptionStatus, &subscriptionTier); err != nil {
		t.Fatalf("read persisted subscription: %v", err)
	}
	if subscriptionStatus != "active" || subscriptionTier != "creator" {
		t.Fatalf("persisted subscription = status:%q tier:%q, want active/creator", subscriptionStatus, subscriptionTier)
	}

	// Exercise the Go adapter for the server-owned subscription creation
	// boundary, not only the SQL functions used by the broader harness. The
	// provider call is represented by a synthetic response; no provider
	// credentials or network request are used by this integration test.
	creationRequest := subscription.Request{
		UserID:          "00000000-0000-4000-8000-000000000001",
		ChannelID:       "00000000-0000-4000-8000-000000000011",
		Environment:     "test",
		IdempotencyKey:  "go-sql-subscription-001",
		Tier:            "creator",
		BillingInterval: "monthly",
	}
	creationPlan := subscription.Plan{
		ProviderAccountScope: "platform",
		ProviderAccountRef:   "acct_bsa_platform",
		ProviderPlanID:       "plan_creator_monthly",
		Tier:                 "creator",
		BillingInterval:      "monthly",
		PricePaise:           39900,
		TotalCount:           12,
		Quantity:             1,
		CustomerNotify:       true,
	}
	createdIntent, err := store.CreateSubscriptionIntent(ctx, creationRequest, creationPlan, "00000000-0000-4000-8000-000000000228")
	if err != nil || createdIntent.Status != "requested" || createdIntent.ID != "00000000-0000-4000-8000-000000000228" {
		t.Fatalf("create subscription intent through SQL store: intent=%+v err=%v", createdIntent, err)
	}
	replayedIntent, err := store.CreateSubscriptionIntent(ctx, creationRequest, creationPlan, "00000000-0000-4000-8000-000000000229")
	if err != nil || replayedIntent.ID != createdIntent.ID || replayedIntent.Status != "requested" {
		t.Fatalf("subscription idempotency replay: intent=%+v err=%v", replayedIntent, err)
	}
	claimedSubscription, claimedOK, err := store.ClaimSubscriptionProviderCreation(
		ctx, createdIntent.ID, "00000000-0000-4000-8000-000000000230", time.Now().Add(time.Minute),
	)
	if err != nil || !claimedOK || claimedSubscription.Status != "provider_pending" {
		t.Fatalf("claim subscription provider creation: intent=%+v claimed=%t err=%v", claimedSubscription, claimedOK, err)
	}
	attachedSubscription, attachedOK, err := store.AttachSubscriptionProvider(
		ctx,
		createdIntent.ID,
		"00000000-0000-4000-8000-000000000230",
		provider.Subscription{
			Entity:   "subscription",
			ID:       "sub_go_store_creation_1",
			PlanID:   "plan_creator_monthly",
			Status:   "created",
			ShortURL: "https://rzp.io/i/go-store-creation",
		},
	)
	if err != nil || !attachedOK || attachedSubscription.Status != "provider_created" || attachedSubscription.ProviderSubscriptionID != "sub_go_store_creation_1" {
		t.Fatalf("attach subscription provider through SQL store: intent=%+v attached=%t err=%v", attachedSubscription, attachedOK, err)
	}
	linkedSubscription, err := store.LinkSubscriptionIntent(ctx, createdIntent.ID)
	if err != nil || linkedSubscription.Status != "linked" {
		t.Fatalf("link subscription intent through SQL store: intent=%+v err=%v", linkedSubscription, err)
	}
	var creationStatus, creationProviderID string
	if err := database.QueryRowContext(ctx, `
select status, provider_subscription_id
  from subscription_creation_intents
 where id = '00000000-0000-4000-8000-000000000228'`).Scan(&creationStatus, &creationProviderID); err != nil {
		t.Fatalf("read persisted subscription creation intent: %v", err)
	}
	if creationStatus != "linked" || creationProviderID != "sub_go_store_creation_1" {
		t.Fatalf("persisted subscription creation intent = status:%q provider:%q, want linked/sub_go_store_creation_1", creationStatus, creationProviderID)
	}

	var status string
	if err := database.QueryRowContext(ctx, `select status from payments where provider_payment_id = 'pay_go_store_1'`).Scan(&status); err != nil {
		t.Fatalf("read persisted payment: %v", err)
	}
	if status != "captured" {
		t.Fatalf("persisted payment status = %q, want captured", status)
	}
	var disputeStatus string
	var linkedPayment string
	if err := database.QueryRowContext(ctx, `
select status, payment_id::text
  from payment_disputes
 where provider_dispute_id = 'disp_go_store_1'`).Scan(&disputeStatus, &linkedPayment); err != nil {
		t.Fatalf("read persisted dispute: %v", err)
	}
	if disputeStatus != "open" || linkedPayment == "" {
		t.Fatalf("persisted dispute = status:%q payment:%q, want open and linked", disputeStatus, linkedPayment)
	}
	var alertCount, deliveryCount int
	if err := database.QueryRowContext(ctx, `
select count(*), coalesce(sum(deliveries), 0)
  from (
    select event.id,
           (select count(*) from event_outbox_deliveries d where d.event_id = event.id) as deliveries
      from alert_events event
      join payments payment on payment.id = event.payment_id
     where payment.provider_payment_id = 'pay_go_store_1'
  ) projected`).Scan(&alertCount, &deliveryCount); err != nil {
		t.Fatalf("read alert projection: %v", err)
	}
	if alertCount != 1 || deliveryCount != 1 {
		t.Fatalf("alert projection = alerts:%d deliveries:%d, want 1/1", alertCount, deliveryCount)
	}
}

func checkoutIntentRequest() checkout.IntentRequest {
	return checkout.IntentRequest{
		IntentID:       "00000000-0000-4000-8000-000000000221",
		ChannelID:      "00000000-0000-4000-8000-000000000011",
		Environment:    "test",
		IdempotencyKey: "go-sql-store-intent-001",
		Receipt:        "go-sql-store-receipt-001",
		AmountPaise:    7000,
		Currency:       "INR",
		DisplayName:    "Go SQL Fixture",
		Message:        "driver integration",
		AlertConsent:   true,
		// Stay below the database's fifteen-minute maximum rather than using
		// the exact boundary, which can fail under small clock/round-trip skew.
		ExpiresAt:      time.Now().Add(10 * time.Minute),
	}
}
