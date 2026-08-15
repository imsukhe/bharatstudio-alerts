package store

import (
	"context"
	"database/sql"

	"github.com/bharatstudio/bharatstudio-alerts/services/alert-worker-go/internal/tasks"
)

type RowsQueryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

type ReadyDeliveryStore struct {
	db RowsQueryer
}

func NewSQLReadyDeliveryStore(db *sql.DB) ReadyDeliveryStore {
	return ReadyDeliveryStore{db: db}
}

func (s ReadyDeliveryStore) ListReady(ctx context.Context, limit int) ([]tasks.ReadyDelivery, error) {
	rows, err := s.db.QueryContext(ctx, `
select delivery_id::text, event_id::text, outbox_id::text, queue_id::text,
       binding_id::text, attempt_number, state_version, trace_id
  from app_private.list_ready_event_deliveries($1::integer)`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var deliveries []tasks.ReadyDelivery
	for rows.Next() {
		var delivery tasks.ReadyDelivery
		if err := rows.Scan(&delivery.DeliveryID, &delivery.EventID, &delivery.OutboxID, &delivery.QueueID, &delivery.BindingID, &delivery.AttemptNumber, &delivery.StateVersion, &delivery.TraceID); err != nil {
			return nil, err
		}
		deliveries = append(deliveries, delivery)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return deliveries, nil
}
