package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/bharatstudio/bharatstudio-alerts/services/youtube-poller-go/internal/domain"
)

// ErrDuplicateEvent is returned when the same (channel, source_type,
// source_id) has already been recorded. Callers treat this as success —
// the message was already delivered, so retrying is a no-op, not a
// failure.
var ErrDuplicateEvent = errors.New("youtube live event already recorded")

// ErrPermanentFailure is returned when an insert failed for a reason that
// retrying would never fix (a data/integrity problem, never a duplicate).
// The failure has already been durably recorded via
// app_private.record_youtube_ingest_failure before this error is returned,
// so the caller may safely advance past the message: it is recorded, not
// dropped.
var ErrPermanentFailure = errors.New("youtube live event permanently rejected (recorded)")

// retryAttempts and retryBaseDelay bound how hard a transient failure (a
// real, non-duplicate database error that a retry has a realistic chance of
// clearing — a dropped connection, a serialization conflict, a deadlock, a
// momentarily unavailable server) is retried before giving up. A tip alert
// is a lost payment notification if dropped, so this trades a few hundred
// milliseconds of latency against never losing the message outright — see
// poller.pollOne, which holds the page cursor in place (does not advance
// past the page) whenever InsertLiveEvent returns anything other than nil,
// ErrDuplicateEvent, or ErrPermanentFailure.
const (
	retryAttempts  = 4
	retryBaseDelay = 100 * time.Millisecond
)

type EventStore struct {
	db    *sql.DB
	sleep func(context.Context, time.Duration) error
}

func NewEventStore(database *sql.DB) *EventStore {
	return &EventStore{db: database, sleep: ctxSleep}
}

func ctxSleep(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// InsertLiveEvent persists one normalised LiveEvent through
// app_private.record_youtube_alert_event — the same delivery mechanism
// every other write path in this codebase uses (create_manual_alert,
// record_verified_payment_webhook): one transaction inserts alert_events,
// event_outbox ('pending'), and (if an active queue_bindings row routes
// this source) event_outbox_deliveries rows ('ready'). See migration 0094.
//
// Idempotency is now a real database guarantee, not only a writer-side
// lock: alert_events_external_source_unique (0091) plus this function's
// ON CONFLICT ... DO NOTHING means a second writer that raced this one, or
// a bug in whatever computed a lock key, cannot produce two alerts for the
// same (channel, 'youtube', source_id).
//
// Failure handling distinguishes three outcomes, because a lost tip alert
// is a lost payment notification:
//   - duplicate            -> ErrDuplicateEvent (skip; already delivered)
//   - transient DB error    -> retried with bounded backoff; if every retry
//     is exhausted, the (wrapped) underlying error is returned as-is so the
//     caller knows this message was NOT recorded and must not be skipped
//     past.
//   - permanent DB error    -> not retried (retrying a data/integrity
//     violation cannot succeed); durably recorded via
//     app_private.record_youtube_ingest_failure and returned wrapped in
//     ErrPermanentFailure, so the caller can safely move on knowing the
//     rejection is visible, not silently dropped.
func (s *EventStore) InsertLiveEvent(ctx context.Context, channelID string, configSnapshotVersion int64, traceID string, event domain.LiveEvent) error {
	payload, err := json.Marshal(event.Payload)
	if err != nil {
		return fmt.Errorf("marshal youtube event payload: %w", err)
	}

	eventID := uuid.New().String()
	outboxID := uuid.New().String()

	var lastErr error
	for attempt := 0; attempt < retryAttempts; attempt++ {
		if attempt > 0 {
			delay := retryBaseDelay * time.Duration(1<<uint(attempt-1))
			delay += time.Duration(rand.Int63n(int64(retryBaseDelay))) // jitter, avoids synchronized retries across goroutines
			if sleepErr := s.sleep(ctx, delay); sleepErr != nil {
				return fmt.Errorf("youtube event insert retry interrupted: %w", sleepErr)
			}
		}

		var duplicate bool
		row := s.db.QueryRowContext(ctx, `
			select inserted = false
			  from app_private.record_youtube_alert_event($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
			eventID, outboxID, channelID, event.SourceID,
			string(event.SourceEventType), event.SourceUserID,
			traceID, configSnapshotVersion, payload)
		scanErr := row.Scan(&duplicate)
		if scanErr == nil {
			if duplicate {
				return ErrDuplicateEvent
			}
			return nil
		}
		lastErr = scanErr

		switch classifyPgError(scanErr) {
		case failurePermanent:
			s.recordPermanentFailure(ctx, channelID, event, payload, scanErr)
			return fmt.Errorf("%w: %v", ErrPermanentFailure, scanErr)
		case failureTransient:
			continue // bounded retry, see loop guard above
		default:
			// Unclassified (e.g. a driver/network error with no SQLSTATE):
			// treated the same as transient — safer to retry a bounded
			// number of times than to assume, without evidence, that this
			// was recorded.
			continue
		}
	}
	return fmt.Errorf("insert youtube alert_events row after %d attempts: %w", retryAttempts, lastErr)
}

// recordPermanentFailure best-effort persists the rejected event via
// app_private.record_youtube_ingest_failure. A failure to record the
// failure itself is logged into the returned error chain via errors.Join
// semantics is deliberately NOT attempted here: this call has already
// decided the message is unrecoverable, and blocking the poller further on
// a second write is not worth it. The original scanErr is always what the
// caller sees either way.
func (s *EventStore) recordPermanentFailure(ctx context.Context, channelID string, event domain.LiveEvent, payload []byte, cause error) {
	var sqlstate string
	var pgErr *pgconn.PgError
	if errors.As(cause, &pgErr) {
		sqlstate = pgErr.Code
	}
	failureID := uuid.New().String()
	_, _ = s.db.ExecContext(ctx, `
		select app_private.record_youtube_ingest_failure($1, $2, $3, $4, $5, $6, $7)`,
		failureID, channelID, event.SourceID, string(event.SourceEventType),
		sqlstate, cause.Error(), payload)
}

type failureClass int

const (
	failureUnknown failureClass = iota
	failureTransient
	failurePermanent
)

// classifyPgError sorts a database error into transient (worth a bounded
// retry) or permanent (retrying cannot possibly succeed) using the
// PostgreSQL SQLSTATE class, which is the only classification signal a
// driver-agnostic caller can rely on. See
// https://www.postgresql.org/docs/16/errcodes-appendix.html.
//
//   - Class 08 (connection exception), 40001 (serialization_failure),
//     40P01 (deadlock_detected), class 53 (insufficient resources), and
//     57P03 (cannot_connect_now) are conditions a retry can plausibly ride
//     out.
//   - Class 22 (data exception) and class 23 (integrity constraint
//     violation, e.g. a NOT NULL or FK violation — NOT the unique
//     violation this function's ON CONFLICT already absorbs) will fail
//     identically on every retry.
//   - Anything else, and any non-PgError (context deadline, network error
//     with no SQLSTATE at all), is treated as transient: the conservative
//     default is to retry rather than to assume, without evidence, that
//     the data itself is at fault.
func classifyPgError(err error) failureClass {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return failureTransient
	}
	code := pgErr.Code
	switch {
	case strings.HasPrefix(code, "08"):
		return failureTransient
	case code == "40001", code == "40P01", code == "57P03":
		return failureTransient
	case strings.HasPrefix(code, "53"):
		return failureTransient
	case strings.HasPrefix(code, "22"), strings.HasPrefix(code, "23"):
		return failurePermanent
	default:
		return failureTransient
	}
}

// LatestConfigSnapshotVersion returns the channel's current config version,
// used to stamp alert_events.config_snapshot_version the same way the
// manual/webhook insert paths do (0019, 0007). Returns 0 if the channel has
// no published config yet.
func LatestConfigSnapshotVersion(ctx context.Context, database *sql.DB, channelID string) (int64, error) {
	var version sql.NullInt64
	err := database.QueryRowContext(ctx, `
		select max(version) from public.channel_configs where channel_id = $1`, channelID).Scan(&version)
	if err != nil {
		return 0, fmt.Errorf("latest config snapshot version: %w", err)
	}
	if !version.Valid {
		return 0, nil
	}
	return version.Int64, nil
}
