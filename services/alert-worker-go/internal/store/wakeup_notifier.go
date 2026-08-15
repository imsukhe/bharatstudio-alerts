package store

import (
	"context"
	"database/sql"
)

type Execer interface {
	ExecContext(ctx context.Context, query string, args ...any) error
}

type WakeupNotifier struct {
	db Execer
}

type sqlExecer struct {
	db *sql.DB
}

func (e sqlExecer) ExecContext(ctx context.Context, query string, args ...any) error {
	_, err := e.db.ExecContext(ctx, query, args...)
	return err
}

func NewSQLWakeupNotifier(db *sql.DB) WakeupNotifier {
	return NewWakeupNotifier(sqlExecer{db: db})
}

func NewWakeupNotifier(db Execer) WakeupNotifier {
	return WakeupNotifier{db: db}
}

// Notify is deliberately best-effort. The delivery is already durable before
// this is called; a notification failure must not cause Cloud Tasks to replay
// a successfully published alert.
func (n WakeupNotifier) Notify(ctx context.Context, channelID, eventID string) error {
	return n.db.ExecContext(ctx, "select app_private.notify_overlay_wakeup($1::uuid, $2::uuid)", channelID, eventID)
}
