package ingress

// L19d — dynamic UPI QR persistence. New file, same SQLStore struct that
// already implements checkout.IntentStore in sql_store.go, because these
// methods need the same *sql.DB and the same environment guard; it is a new
// file so the existing, reviewed sql_store.go is never touched by this task.
import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/bharatstudio/bharatstudio-alerts/services/payment-webhook-go/internal/qr"
)

// GetEligibleIntent implements qr.IntentLookup. It reads only the
// already-persisted, immutable intent fields a QR may be created against —
// it never accepts amount/currency/account from the QR request itself.
func (s *SQLStore) GetEligibleIntent(ctx context.Context, intentID, channelID, environment string) (qr.EligibleIntent, error) {
	if environment != s.environment {
		return qr.EligibleIntent{}, ErrPaymentStoreConfig
	}
	var intent qr.EligibleIntent
	err := s.db.QueryRowContext(ctx, `
select intent_id::text, connected_account_ref, amount_paise, currency, provider_receipt, status
  from app_private.get_eligible_payment_order_intent($1::uuid, $2::uuid, $3::text)`,
		intentID, channelID, environment,
	).Scan(&intent.ID, &intent.ConnectedAccountRef, &intent.AmountPaise, &intent.Currency, &intent.Receipt, &intent.Status)
	if errors.Is(err, sql.ErrNoRows) {
		return qr.EligibleIntent{}, qr.ErrIntentNotEligible
	}
	if err != nil {
		return qr.EligibleIntent{}, err
	}
	return intent, nil
}

// CreateOrGetQr implements qr.Store. It is idempotent per intent: a retry
// with the same intent id returns the same row rather than creating a
// second QR for it.
func (s *SQLStore) CreateOrGetQr(ctx context.Context, id string, intent qr.EligibleIntent, closeBy time.Time) (qr.Record, error) {
	var record qr.Record
	var providerQrID, qrImageURL sql.NullString
	var closeByOut time.Time
	err := s.db.QueryRowContext(ctx, `
select qr_id::text, connected_account_ref, amount_paise, currency, provider_receipt,
       provider_qr_id, qr_image_url, close_by
  from app_private.create_payment_order_qr($1::uuid, $2::uuid, $3::timestamptz)`,
		id, intent.ID, closeBy,
	).Scan(&record.ID, &record.ConnectedAccountRef, &record.AmountPaise, &record.Currency, &record.Receipt, &providerQrID, &qrImageURL, &closeByOut)
	if err != nil {
		return qr.Record{}, err
	}
	record.IntentID = intent.ID
	record.CloseBy = closeByOut
	if providerQrID.Valid {
		record.ProviderQrID = providerQrID.String
	}
	if qrImageURL.Valid {
		record.QrImageURL = qrImageURL.String
	}
	return record, nil
}

func (s *SQLStore) ClaimQrProviderCreation(ctx context.Context, qrID, claimToken string, claimUntil time.Time) (qr.Record, bool, error) {
	var record qr.Record
	err := s.db.QueryRowContext(ctx, `
select qr_id::text, amount_paise, currency, provider_receipt
  from app_private.claim_payment_order_qr($1::uuid, $2::uuid, $3::timestamptz)`, qrID, claimToken, claimUntil,
	).Scan(&record.ID, &record.AmountPaise, &record.Currency, &record.Receipt)
	if errors.Is(err, sql.ErrNoRows) {
		return qr.Record{}, false, nil
	}
	if err != nil {
		return qr.Record{}, false, err
	}
	return record, true, nil
}

func (s *SQLStore) AttachProviderQr(ctx context.Context, qrID, claimToken, providerQrID, qrImageURL string, providerCreatedAt time.Time) (qr.Record, bool, error) {
	var record qr.Record
	err := s.db.QueryRowContext(ctx, `
select qr_id::text, provider_qr_id, qr_image_url, status
  from app_private.attach_provider_qr($1::uuid, $2::uuid, $3::text, $4::text, $5::timestamptz)`,
		qrID, claimToken, providerQrID, qrImageURL, providerCreatedAt,
	).Scan(&record.ID, &record.ProviderQrID, &record.QrImageURL, &record.Status)
	if errors.Is(err, sql.ErrNoRows) {
		return qr.Record{}, false, nil
	}
	if err != nil {
		return qr.Record{}, false, err
	}
	return record, true, nil
}
