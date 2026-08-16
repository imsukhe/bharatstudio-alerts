package ingress

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/bharatstudio/bharatstudio-alerts/services/payment-webhook-go/internal/checkout"
	"github.com/bharatstudio/bharatstudio-alerts/services/payment-webhook-go/internal/provider"
	"github.com/bharatstudio/bharatstudio-alerts/services/payment-webhook-go/internal/reconcile"
	"github.com/bharatstudio/bharatstudio-alerts/services/payment-webhook-go/internal/subscription"
	"github.com/bharatstudio/bharatstudio-alerts/services/payment-webhook-go/internal/webhook"
)

var ErrPaymentStoreConfig = errors.New("invalid payment store configuration")

// SQLStore is the payment service's database adapter. It performs only
// preflight reads needed to construct queue rows, then delegates the actual
// financial/webhook/outbox write to one private transaction-scoped function.
// It does not accept a channel or account from the webhook body.
type SQLStore struct {
	db          *sql.DB
	environment string
}

func NewSQLStore(db *sql.DB, environment string) (*SQLStore, error) {
	if db == nil || (environment != "test" && environment != "live") {
		return nil, ErrPaymentStoreConfig
	}
	return &SQLStore{db: db, environment: environment}, nil
}

// RegisterSubscriptionLink records the server-approved mapping returned by a
// future Razorpay subscription-creation flow. Platform plan subscriptions and
// creator-connected subscriptions use different account scopes; webhook
// payloads cannot choose the channel, tier or price and must resolve through
// this link first.
func (s *SQLStore) RegisterSubscriptionLink(ctx context.Context, channelID, accountScope, accountRef, subscriptionID, planID, tier, interval string, pricePaise int64) (string, error) {
	var result string
	err := s.db.QueryRowContext(ctx, `
select app_private.register_channel_subscription_link(
  $1::uuid, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, $8::text, $9::bigint
)`, channelID, s.environment, accountScope, accountRef, subscriptionID, planID, tier, interval, pricePaise).Scan(&result)
	return result, err
}

func (s *SQLStore) CreateSubscriptionIntent(ctx context.Context, request subscription.Request, plan subscription.Plan, intentID string) (subscription.Intent, error) {
	row := s.db.QueryRowContext(ctx, `
select id::text, channel_id::text, user_id::text, environment,
       provider_account_scope, provider_account_ref, provider_plan_id, tier,
       billing_interval, recurring_price_paise, provider_subscription_id,
       provider_status, checkout_url, status
  from app_private.create_subscription_creation_intent(
    $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::text, $7::text,
    $8::text, $9::text, $10::text, $11::bigint
  )`, intentID, request.UserID, request.ChannelID, request.Environment,
		request.IdempotencyKey, plan.ProviderAccountScope, plan.ProviderAccountRef,
		plan.ProviderPlanID, plan.Tier, plan.BillingInterval, plan.PricePaise)
	return scanSubscriptionIntent(row)
}

func (s *SQLStore) ClaimSubscriptionProviderCreation(ctx context.Context, intentID, claimToken string, claimUntil time.Time) (subscription.Intent, bool, error) {
	row := s.db.QueryRowContext(ctx, `
select id::text, channel_id::text, user_id::text, environment,
       provider_account_scope, provider_account_ref, provider_plan_id, tier,
       billing_interval, recurring_price_paise, provider_subscription_id,
       provider_status, checkout_url, status
  from app_private.claim_subscription_provider_creation($1::uuid, $2::uuid, $3::timestamptz)`, intentID, claimToken, claimUntil)
	intent, err := scanSubscriptionIntent(row)
	if errors.Is(err, sql.ErrNoRows) {
		return subscription.Intent{}, false, nil
	}
	return intent, err == nil, err
}

func (s *SQLStore) AttachSubscriptionProvider(ctx context.Context, intentID, claimToken string, created provider.Subscription) (subscription.Intent, bool, error) {
	row := s.db.QueryRowContext(ctx, `
select id::text, channel_id::text, user_id::text, environment,
       provider_account_scope, provider_account_ref, provider_plan_id, tier,
       billing_interval, recurring_price_paise, provider_subscription_id,
       provider_status, checkout_url, status
  from app_private.attach_subscription_provider(
    $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::timestamptz
  )`, intentID, claimToken, created.ID, created.Status, nullableText(created.ShortURL), time.Now())
	intent, err := scanSubscriptionIntent(row)
	if errors.Is(err, sql.ErrNoRows) {
		return subscription.Intent{}, false, nil
	}
	return intent, err == nil, err
}

func (s *SQLStore) LinkSubscriptionIntent(ctx context.Context, intentID string) (subscription.Intent, error) {
	row := s.db.QueryRowContext(ctx, `
select id::text, channel_id::text, user_id::text, environment,
       provider_account_scope, provider_account_ref, provider_plan_id, tier,
       billing_interval, recurring_price_paise, provider_subscription_id,
       provider_status, checkout_url, status
  from app_private.link_subscription_creation_intent($1::uuid)`, intentID)
	return scanSubscriptionIntent(row)
}

func (s *SQLStore) MarkSubscriptionRecovery(ctx context.Context, intentID, errorCode string) (subscription.Intent, error) {
	row := s.db.QueryRowContext(ctx, `
select id::text, channel_id::text, user_id::text, environment,
       provider_account_scope, provider_account_ref, provider_plan_id, tier,
       billing_interval, recurring_price_paise, provider_subscription_id,
       provider_status, checkout_url, status
  from app_private.mark_subscription_creation_recovery($1::uuid, $2::text)`, intentID, errorCode)
	return scanSubscriptionIntent(row)
}

// GetActiveSubscriptionRef resolves the channel's current active/past_due
// Razorpay subscription so a lifecycle request (cancel/change-plan/
// reactivate) knows which provider entity to call. Returns ok=false when the
// channel has no active-or-past_due subscription (nothing to act on).
func (s *SQLStore) GetActiveSubscriptionRef(ctx context.Context, channelID string) (subscription.ActiveSubscriptionRef, bool, error) {
	var ref subscription.ActiveSubscriptionRef
	err := s.db.QueryRowContext(ctx, `
select provider_account_ref, provider_subscription_id, tier, billing_interval, status, auto_renew
  from app_private.get_active_subscription_ref($1::uuid)`, channelID,
	).Scan(&ref.ProviderAccountRef, &ref.SubscriptionID, &ref.Tier, &ref.BillingInterval, &ref.Status, &ref.AutoRenew)
	if errors.Is(err, sql.ErrNoRows) {
		return subscription.ActiveSubscriptionRef{}, false, nil
	}
	if err != nil {
		return subscription.ActiveSubscriptionRef{}, false, err
	}
	return ref, true, nil
}

// RecordLifecycleRequest is the idempotent audit step before a lifecycle
// request calls Razorpay — a retried request with the same idempotency key
// returns the original outcome (replay=true) rather than calling the
// provider twice.
func (s *SQLStore) RecordLifecycleRequest(ctx context.Context, id, channelID, userID, action, idempotencyKey, providerSubscriptionID, targetTier, targetBillingInterval string) (subscription.LifecycleRequest, error) {
	var result subscription.LifecycleRequest
	var providerResponseStatus sql.NullString
	err := s.db.QueryRowContext(ctx, `
select id::text, status, provider_response_status, replay
  from app_private.record_subscription_lifecycle_request(
    $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::text,
    nullif($7, '')::text, nullif($8, '')::text
  )`, id, channelID, userID, action, idempotencyKey, providerSubscriptionID, targetTier, targetBillingInterval,
	).Scan(&result.ID, &result.Status, &providerResponseStatus, &result.Replay)
	if err != nil {
		return subscription.LifecycleRequest{}, err
	}
	if providerResponseStatus.Valid {
		result.ProviderResponseStatus = providerResponseStatus.String
	}
	return result, nil
}

// CompleteLifecycleRequest marks a lifecycle request's terminal outcome
// after the Razorpay call returns (or fails).
func (s *SQLStore) CompleteLifecycleRequest(ctx context.Context, id, status, providerResponseStatus string) error {
	var found bool
	err := s.db.QueryRowContext(ctx, `
select app_private.complete_subscription_lifecycle_request($1::uuid, $2::text, nullif($3, ''))`,
		id, status, providerResponseStatus,
	).Scan(&found)
	if err != nil {
		return err
	}
	if !found {
		return sql.ErrNoRows
	}
	return nil
}

type subscriptionIntentScanner interface {
	Scan(dest ...any) error
}

func scanSubscriptionIntent(row subscriptionIntentScanner) (subscription.Intent, error) {
	var intent subscription.Intent
	var providerSubscriptionID, providerStatus, checkoutURL sql.NullString
	err := row.Scan(
		&intent.ID, &intent.ChannelID, &intent.UserID, &intent.Environment,
		&intent.ProviderAccountScope, &intent.ProviderAccountRef, &intent.ProviderPlanID,
		&intent.Tier, &intent.BillingInterval, &intent.PricePaise,
		&providerSubscriptionID, &providerStatus, &checkoutURL, &intent.Status,
	)
	if err != nil {
		return subscription.Intent{}, err
	}
	if providerSubscriptionID.Valid {
		intent.ProviderSubscriptionID = providerSubscriptionID.String
	}
	if providerStatus.Valid {
		intent.ProviderStatus = providerStatus.String
	}
	if checkoutURL.Valid {
		intent.CheckoutURL = checkoutURL.String
	}
	return intent, nil
}

func nullableText(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func (s *SQLStore) CreateIntent(ctx context.Context, request checkout.IntentRequest) (checkout.Intent, error) {
	if request.Environment != s.environment {
		return checkout.Intent{}, ErrPaymentStoreConfig
	}
	var intent checkout.Intent
	var providerOrderID sql.NullString
	err := s.db.QueryRowContext(ctx, `
	select intent_id::text, connected_account_ref, amount_paise, currency, provider_receipt,
	       provider_order_id, donor_display_name, donor_message, alert_consent, status
  from app_private.create_payment_order_intent(
    $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::bigint,
	    $7::text, $8::text, $9::boolean, $10::timestamptz
  )`, request.IntentID, request.ChannelID, request.Environment,
		request.IdempotencyKey, request.Receipt, request.AmountPaise,
		request.DisplayName, request.Message, request.AlertConsent, request.ExpiresAt,
	).Scan(&intent.ID, &intent.ConnectedAccountRef, &intent.AmountPaise, &intent.Currency, &intent.Receipt, &providerOrderID, &intent.DisplayName, &intent.Message, &intent.AlertConsent, &intent.Status)
	if err != nil {
		return checkout.Intent{}, err
	}
	if providerOrderID.Valid {
		intent.ProviderOrderID = providerOrderID.String
	}
	return intent, nil
}

func (s *SQLStore) ClaimProviderCreation(ctx context.Context, intentID, claimToken string, claimUntil time.Time) (checkout.Intent, bool, error) {
	var intent checkout.Intent
	err := s.db.QueryRowContext(ctx, `
select intent_id::text, amount_paise, currency, provider_receipt
  from app_private.claim_payment_order_intent($1::uuid, $2::uuid, $3::timestamptz)`, intentID, claimToken, claimUntil,
	).Scan(&intent.ID, &intent.AmountPaise, &intent.Currency, &intent.Receipt)
	if errors.Is(err, sql.ErrNoRows) {
		return checkout.Intent{}, false, nil
	}
	if err != nil {
		return checkout.Intent{}, false, err
	}
	intent.Status = "provider_pending"
	return intent, true, nil
}

func (s *SQLStore) AttachProviderOrder(ctx context.Context, intentID, claimToken, providerOrderID string, providerCreatedAt time.Time) (checkout.Intent, bool, error) {
	var intent checkout.Intent
	err := s.db.QueryRowContext(ctx, `
select intent_id::text, provider_order_id, status
  from app_private.attach_provider_order($1::uuid, $2::uuid, $3::text, $4::timestamptz)`, intentID, claimToken, providerOrderID, providerCreatedAt,
	).Scan(&intent.ID, &intent.ProviderOrderID, &intent.Status)
	if errors.Is(err, sql.ErrNoRows) {
		return checkout.Intent{}, false, nil
	}
	if err != nil {
		return checkout.Intent{}, false, err
	}
	return intent, true, nil
}

func (s *SQLStore) PersistVerified(ctx context.Context, delivery webhook.Delivery, rawBody []byte) (bool, error) {
	event, err := webhook.ParseEvent(rawBody)
	if err != nil {
		return false, fmt.Errorf("%w: %v", ErrInvalidWebhookPayload, err)
	}
	if event.AccountID == "" {
		return false, fmt.Errorf("%w: missing account attribution", ErrInvalidWebhookPayload)
	}
	normalized, err := json.Marshal(map[string]any{
		"event":        event.Name,
		"entityType":   event.EntityType,
		"entityId":     event.EntityID,
		"paymentId":    event.PaymentID,
		"orderId":      event.OrderID,
		"amountPaise":  event.AmountPaise,
		"currency":     event.Currency,
		"status":       event.Status,
		"refundAmount": event.RefundAmount,
		"planId":       event.PlanID,
		"currentStart": event.CurrentStart,
		"currentEnd":   event.CurrentEnd,
		"chargeAt":     event.ChargeAt,
	})
	if err != nil {
		return false, fmt.Errorf("marshal normalized webhook: %w", err)
	}
	if event.EntityType == "subscription" {
		var duplicate, quarantined bool
		var status string
		err = s.db.QueryRowContext(ctx, `
select duplicate, quarantined, delivery_status
  from app_private.record_verified_subscription_webhook(
    $1::uuid, $2::text, $3::text, $4::text, $5::text,
    current_timestamp, current_timestamp, $6::jsonb
  )`, newUUID(), s.environment, event.AccountID, delivery.ProviderEventID,
			delivery.RawBodyHash, normalized,
		).Scan(&duplicate, &quarantined, &status)
		if err != nil {
			return false, fmt.Errorf("persist verified subscription webhook: %w", err)
		}
		if quarantined {
			return false, fmt.Errorf("%w: subscription status %s", ErrQuarantinedWebhook, status)
		}
		return duplicate, nil
	}
	if event.EntityType == "dispute" {
		var duplicate, quarantined bool
		var persistedPaymentID, persistedDisputeID sql.NullString
		var status string
		err = s.db.QueryRowContext(ctx, `
select duplicate, quarantined, payment_id::text, dispute_id::text, delivery_status
  from app_private.record_verified_dispute_webhook(
    $1::uuid, $2::text, $3::text, $4::text, $5::text,
    current_timestamp, current_timestamp, $6::jsonb, $7::uuid
		)`, newUUID(), s.environment, event.AccountID, delivery.ProviderEventID,
			delivery.RawBodyHash, normalized, newUUID(),
		).Scan(&duplicate, &quarantined, &persistedPaymentID, &persistedDisputeID, &status)
		if err != nil {
			return false, fmt.Errorf("persist verified dispute webhook: %w", err)
		}
		if quarantined {
			return false, fmt.Errorf("%w: dispute status %s", ErrQuarantinedWebhook, status)
		}
		return duplicate, nil
	}

	var channelID string
	deliveryRows := []deliveryRow{}
	if event.EntityType == "payment" && event.OrderID != "" {
		if err := s.db.QueryRowContext(ctx, `
select channel_id::text
  from payment_order_intents
 where provider = 'razorpay'
   and environment = $1
   and connected_account_ref = $2
   and provider_order_id = $3
		limit 1`, s.environment, event.AccountID, event.OrderID).Scan(&channelID); err == nil {
			deliveryRows, err = s.queueRows(ctx, channelID, event.PaymentID)
			if err != nil {
				return false, err
			}
		} else if !errors.Is(err, sql.ErrNoRows) {
			return false, fmt.Errorf("resolve payment intent: %w", err)
		}
	}

	paymentID := nullableUUID(event.EntityType == "payment")
	refundID := nullableUUID(event.EntityType == "refund")
	alertEventID := nullableUUID(event.EntityType == "payment" && isCapturedEvent(event.Name))
	outboxID := nullableUUID(event.EntityType == "payment" && isCapturedEvent(event.Name))
	rowsJSON, err := json.Marshal(deliveryRows)
	if err != nil {
		return false, fmt.Errorf("marshal delivery rows: %w", err)
	}

	var duplicate, quarantined bool
	var persistedPaymentID, persistedAlertID sql.NullString
	var status string
	err = s.db.QueryRowContext(ctx, `
select duplicate, quarantined, payment_id::text, alert_event_id::text, delivery_status
  from app_private.record_verified_payment_webhook(
    $1::uuid, $2::text, $3::text, $4::text, $5::text,
    current_timestamp, current_timestamp, $6::jsonb,
    nullif($7, '')::uuid, nullif($8, '')::uuid,
    nullif($9, '')::uuid, nullif($10, '')::uuid, $11::jsonb
		)`, newUUID(), s.environment, event.AccountID, delivery.ProviderEventID,
		delivery.RawBodyHash, normalized, paymentID, refundID, alertEventID, outboxID, rowsJSON,
	).Scan(&duplicate, &quarantined, &persistedPaymentID, &persistedAlertID, &status)
	if err != nil {
		return false, fmt.Errorf("persist verified webhook: %w", err)
	}
	if quarantined {
		return false, fmt.Errorf("%w: payment status %s", ErrQuarantinedWebhook, status)
	}
	return duplicate, nil
}

// PersistRecoveredPayment uses the same atomic persistence function as a
// webhook, but with a deterministic internal recovery evidence key. The
// caller has already fetched the payment over the authenticated provider API
// and matched its order, amount, currency and captured status to the intent.
func (s *SQLStore) PersistRecoveredPayment(ctx context.Context, candidate reconcile.Candidate, payment provider.Payment) (bool, error) {
	rawBody, err := json.Marshal(map[string]any{
		"event":      "payment.captured",
		"account_id": candidate.ConnectedAccountRef,
		"payload":    map[string]any{"payment": map[string]any{"entity": "payment", "id": payment.ID, "amount": payment.AmountPaise, "currency": payment.Currency, "status": payment.Status, "order_id": payment.OrderID}},
	})
	if err != nil {
		return false, fmt.Errorf("marshal recovered payment: %w", err)
	}
	hash := sha256.Sum256(rawBody)
	return s.PersistVerified(ctx, webhook.Delivery{ProviderEventID: recoveryProviderEventID(candidate.ProviderOrderID, payment.ID), RawBodyHash: hex.EncodeToString(hash[:])}, rawBody)
}

// recoveryProviderEventID is a deterministic internal delivery key. Provider
// and payment IDs have already been validated as safe provider identifiers;
// keep the separator safe too because this value is persisted in the same
// provider-event key column as signed webhook deliveries.
func recoveryProviderEventID(providerOrderID, paymentID string) string {
	return "recovery_" + providerOrderID + "_" + paymentID
}

func (s *SQLStore) CompletePaymentRecovery(ctx context.Context, providerOrderID string) error {
	var status string
	return s.db.QueryRowContext(ctx, `select status from app_private.complete_payment_recovery($1::text)`, providerOrderID).Scan(&status)
}

type deliveryRow struct {
	DeliveryID            string          `json:"deliveryId"`
	QueueID               string          `json:"queueId"`
	BindingID             string          `json:"bindingId"`
	AllowDuplicates       bool            `json:"allowDuplicates"`
	ConfigSnapshotVersion int64           `json:"configSnapshotVersion"`
	DeliverySequence      int64           `json:"deliverySequence"`
	SourcePriority        int             `json:"sourcePriority"`
	OverrideValues        json.RawMessage `json:"overrideValues"`
}

func (s *SQLStore) queueRows(ctx context.Context, channelID, paymentID string) ([]deliveryRow, error) {
	rows, err := s.db.QueryContext(ctx, `
with candidates as (
  select binding.id::text as binding_id,
         binding.queue_id::text as queue_id,
         binding.allow_duplicates,
         coalesce(config.version, 1) as config_snapshot_version,
         row_number() over (order by binding.priority desc, binding.created_at asc, binding.id asc) as route_order,
         count(*) over () as route_count,
         bool_and(binding.allow_duplicates) over () as all_allow_duplicates,
         binding.priority,
         binding.override_values
   from queue_bindings binding
   join alert_queues queue on queue.id = binding.queue_id
                              and queue.channel_id = binding.channel_id
                              and queue.closed_at is null
   left join lateral (
      select version
        from channel_configs
       where channel_id = binding.channel_id
       order by version desc
       limit 1
    ) config on true
   where binding.channel_id = $1::uuid
     and binding.closed_at is null
     and binding.source_type = 'payment'
     and binding.source_id in ($2, '__channel_default__')
     and not (
       binding.source_id = '__channel_default__'
       and exists (
         select 1
           from queue_bindings exact_binding
          where exact_binding.channel_id = $1::uuid
            and exact_binding.closed_at is null
            and exact_binding.source_type = 'payment'
            and exact_binding.source_id = $2
       )
     )
)
select binding_id,
       queue_id,
       allow_duplicates,
       config_snapshot_version,
       route_order,
       priority,
       override_values
  from candidates
 where route_count = 1
    or all_allow_duplicates
    or route_order = 1
 order by route_order`, channelID, paymentID)
	if err != nil {
		return nil, fmt.Errorf("resolve payment queue bindings: %w", err)
	}
	defer rows.Close()
	var result []deliveryRow
	for rows.Next() {
		var row deliveryRow
		if err := rows.Scan(&row.BindingID, &row.QueueID, &row.AllowDuplicates, &row.ConfigSnapshotVersion, &row.DeliverySequence, &row.SourcePriority, &row.OverrideValues); err != nil {
			return nil, fmt.Errorf("scan payment queue binding: %w", err)
		}
		row.DeliveryID = newUUID()
		result = append(result, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read payment queue bindings: %w", err)
	}
	sort.SliceStable(result, func(i, j int) bool { return result[i].DeliverySequence < result[j].DeliverySequence })
	return result, nil
}

func isCapturedEvent(eventName string) bool {
	return eventName == "payment.captured" || eventName == "order.paid"
}

func nullableUUID(enabled bool) string {
	if !enabled {
		return ""
	}
	return newUUID()
}

func newUUID() string {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		panic("crypto/rand unavailable")
	}
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		value[0:4], value[4:6], value[6:8], value[8:10], value[10:16])
}
