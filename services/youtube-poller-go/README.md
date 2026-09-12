# youtube-poller-go

Discovers which connected YouTube channels are currently live and polls each
one's live chat, normalising Super Chat / Super Sticker / membership events
into the canonical `LiveEvent` shape (`internal/domain`, ported from
`apps/api/src/domain/youtube-live-event.ts`) and inserting them into
`alert_events` (`source_type='youtube'`).

See the task report for the quota model, idempotency guarantee, and open
items blocked on external dependencies (Google OAuth app verification, the
Data API quota increase) or on a follow-up migration (the missing unique
constraint on `alert_events`, and the missing GRANTs for this service's
database role — see `internal/store/connections.go`).

## Configuration

All configuration is environment-only — see `.env.example`. No real Google
client id, secret, or token is ever hardcoded.

## Layout

- `internal/domain` — normalisation, ported 1:1 from the TypeScript mapping.
- `internal/youtube` — YouTube Data API v3 client (discovery, chat polling,
  OAuth token refresh).
- `internal/quota` — the daily budget, per-channel fair share, and backoff.
- `internal/tokencrypto` — AES-256-GCM decrypt/encrypt matching
  `apps/api/src/notifications/token-crypto.ts`'s `v1.<iv>.<tag>.<ciphertext>`
  envelope.
- `internal/store` — the only SQL boundary (connections, events).
- `internal/poller` — orchestration.

## Running tests

```sh
go build ./...
go test ./...
```
