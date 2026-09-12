package store

import (
	"context"
	"database/sql"
	"fmt"
)

// TipIntentDedupStore wraps the SECURITY DEFINER functions migration 0101
// grants to bsa_connector_poller: reserve_youtube_tip_intent,
// mark_youtube_tip_intent_created, mark_youtube_tip_intent_failed,
// release_youtube_tip_intent_reservation. It never touches
// public.youtube_tip_intent_dedup directly — that table has no raw grant
// for any role (see 0101's own comment), matching every other
// connector-owned table in this codebase.
type TipIntentDedupStore struct {
	db *sql.DB
}

func NewTipIntentDedupStore(database *sql.DB) *TipIntentDedupStore {
	return &TipIntentDedupStore{db: database}
}

// Reserve attempts to claim (channelID, sourceChatMessageID) for TipIntent
// creation. reserved=false means a row for this exact chat message id
// already exists (in any status: another goroutine's in-flight attempt,
// an already-created TipIntent, or a permanently-failed one) — the caller
// must treat that as "already handled" and create nothing.
func (s *TipIntentDedupStore) Reserve(ctx context.Context, dedupID, channelID, sourceChatMessageID string) (reserved bool, err error) {
	row := s.db.QueryRowContext(ctx, `
		select reserved from app_private.reserve_youtube_tip_intent($1, $2, $3)`,
		dedupID, channelID, sourceChatMessageID)
	if err := row.Scan(&reserved); err != nil {
		return false, fmt.Errorf("reserve youtube tip intent: %w", err)
	}
	return reserved, nil
}

// MarkCreated records a successful TipIntent creation. Terminal: this chat
// message id is never reserved again.
func (s *TipIntentDedupStore) MarkCreated(ctx context.Context, dedupID string) error {
	if _, err := s.db.ExecContext(ctx, `select app_private.mark_youtube_tip_intent_created($1)`, dedupID); err != nil {
		return fmt.Errorf("mark youtube tip intent created: %w", err)
	}
	return nil
}

// MarkFailed records a permanent failure (see tipintent.FailurePermanent).
// Terminal: this chat message id is never reserved again, but a different
// message id on the same channel is unaffected.
func (s *TipIntentDedupStore) MarkFailed(ctx context.Context, dedupID, errorDetail string) error {
	if _, err := s.db.ExecContext(ctx, `select app_private.mark_youtube_tip_intent_failed($1, $2)`, dedupID, errorDetail); err != nil {
		return fmt.Errorf("mark youtube tip intent failed: %w", err)
	}
	return nil
}

// Release undoes a still-pending reservation after a transient failure
// (see tipintent.FailureTransient), so the same chat message id can be
// re-attempted on a later poll cycle. It is always a no-op against a row
// that already reached a terminal status.
func (s *TipIntentDedupStore) Release(ctx context.Context, dedupID string) error {
	if _, err := s.db.ExecContext(ctx, `select app_private.release_youtube_tip_intent_reservation($1)`, dedupID); err != nil {
		return fmt.Errorf("release youtube tip intent reservation: %w", err)
	}
	return nil
}
