// Package store is the poller's only SQL boundary: reading active
// connector rows (with token ciphertext, which the API's own
// get_youtube_connections() deliberately never returns — see 0086) and
// persisting refreshed tokens and normalised events.
//
// NOTE ON GRANTS: migration 0086 revokes all privileges on
// youtube_channel_connections from public, bsa_app and bsa_payment, and
// grants none to any role for this service to read token columns or write
// alert_events. This package assumes a role with the necessary SELECT
// (youtube_channel_connections, including token columns) and UPDATE
// (token refresh) and INSERT (alert_events) privileges will be granted by
// a follow-up migration — see Remaining open in this task's report; no
// migration is added here.
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// Connection is one active youtube_channel_connections row, tokens still
// encrypted — decryption happens one layer up where the key lives.
type Connection struct {
	ID                     string
	ChannelID              string
	ExternalChannelID      string
	AccessTokenCiphertext  sql.NullString
	RefreshTokenCiphertext sql.NullString
	TokenExpiresAt         sql.NullTime
}

type ConnectionsStore struct {
	db *sql.DB
}

func NewConnectionsStore(database *sql.DB) *ConnectionsStore {
	return &ConnectionsStore{db: database}
}

// ActiveConnections lists every non-revoked connector across all channels.
// The poller discovers liveness itself (bullet 1) rather than trusting any
// cached "is live" flag, so this intentionally returns every active
// connection, live or not.
func (s *ConnectionsStore) ActiveConnections(ctx context.Context) ([]Connection, error) {
	rows, err := s.db.QueryContext(ctx, `
		select id, channel_id, external_channel_id,
		       access_token_ciphertext, refresh_token_ciphertext, token_expires_at
		  from public.youtube_channel_connections
		 where status = 'active'
		 order by channel_id, id`)
	if err != nil {
		return nil, fmt.Errorf("list active youtube connections: %w", err)
	}
	defer rows.Close()

	var connections []Connection
	for rows.Next() {
		var c Connection
		if err := rows.Scan(&c.ID, &c.ChannelID, &c.ExternalChannelID,
			&c.AccessTokenCiphertext, &c.RefreshTokenCiphertext, &c.TokenExpiresAt); err != nil {
			return nil, fmt.Errorf("scan youtube connection: %w", err)
		}
		connections = append(connections, c)
	}
	return connections, rows.Err()
}

// UpdateAccessToken persists a refreshed access token in place. The refresh
// token and its fingerprint are untouched: Google does not rotate the
// refresh token on a refresh_token grant.
func (s *ConnectionsStore) UpdateAccessToken(ctx context.Context, connectionID, ciphertext, fingerprint string, expiresAt time.Time) error {
	result, err := s.db.ExecContext(ctx, `
		update public.youtube_channel_connections
		   set access_token_ciphertext = $2,
		       access_token_fingerprint = $3,
		       token_expires_at = $4,
		       updated_at = current_timestamp
		 where id = $1 and status = 'active'`,
		connectionID, ciphertext, fingerprint, expiresAt)
	if err != nil {
		return fmt.Errorf("update youtube access token: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		return errors.New("update youtube access token: connection not found or no longer active")
	}
	return nil
}
