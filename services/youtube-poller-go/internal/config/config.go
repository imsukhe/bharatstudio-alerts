// Package config loads this service's configuration strictly from the
// environment — no real Google client id, secret, or token is ever
// hardcoded here or anywhere else in this service.
package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	DatabaseURL          string
	DatabaseMaxOpenConns int
	DatabaseMaxIdleConns int

	GoogleClientID     string
	GoogleClientSecret string
	TokenEncryptionKey string // 64 hex chars; see internal/tokencrypto

	YoutubeAPIBaseURL string
	YoutubeTokenURL   string

	QuotaDailyUnits int64

	PollCycleInterval time.Duration // how often the poller re-scans for live channels
	MinChatPollDelay  time.Duration // floor under a misbehaving/absent pollingIntervalMillis

	// TipIntentServiceURL/TipIntentServiceSecret configure the call to
	// apps/api's internal TipIntent creation endpoint (0097/0101 — see
	// internal/tipintent). Both optional: an empty URL or secret disables
	// TipIntent creation entirely (a parsed !tip is simply not acted on),
	// exactly like tts.go's optional quotaMeter upstream — this lets the
	// poller run in environments that have not wired up the connector
	// secret yet, rather than hard-failing at startup. The secret is read
	// from the environment only; it is never hardcoded anywhere in this
	// service.
	TipIntentServiceURL    string
	TipIntentServiceSecret string

	// TipBotAckEnabled gates posting the TipIntent short link back into
	// chat (internal/chatcommand.PostTipAcknowledgement). MUST default to
	// false: the chat-write scope this requires is not yet verified with
	// Google (governance/AGENTS.md:28 — no conclusion is drawn here about
	// verification status), and this must not go live by accident. With
	// it false, TipIntent creation itself still runs — only the chat
	// reply is skipped.
	TipBotAckEnabled bool

	Port string
}

func Load() (Config, error) {
	cfg := Config{
		YoutubeAPIBaseURL:      envString("YOUTUBE_API_BASE_URL", ""),
		YoutubeTokenURL:        envString("YOUTUBE_TOKEN_URL", ""),
		TipIntentServiceURL:    envString("YOUTUBE_TIPINTENT_SERVICE_URL", ""),
		TipIntentServiceSecret: envString("YOUTUBE_TIPINTENT_SERVICE_SECRET", ""),
		TipBotAckEnabled:       envBool("YOUTUBE_TIP_BOT_ACK_ENABLED", false),
		Port:                   envString("PORT", "8080"),
	}

	var err error
	if cfg.DatabaseURL, err = requiredEnv("YOUTUBE_POLLER_DATABASE_URL"); err != nil {
		return Config{}, err
	}
	if cfg.GoogleClientID, err = requiredEnv("YOUTUBE_OAUTH_CLIENT_ID"); err != nil {
		return Config{}, err
	}
	if cfg.GoogleClientSecret, err = requiredEnv("YOUTUBE_OAUTH_CLIENT_SECRET"); err != nil {
		return Config{}, err
	}
	if cfg.TokenEncryptionKey, err = requiredEnv("NOTIFICATION_TOKEN_ENCRYPTION_KEY"); err != nil {
		return Config{}, err
	}

	if cfg.DatabaseMaxOpenConns, err = envInt("YOUTUBE_POLLER_DB_MAX_OPEN", 8); err != nil {
		return Config{}, err
	}
	if cfg.DatabaseMaxIdleConns, err = envInt("YOUTUBE_POLLER_DB_MAX_IDLE", 8); err != nil {
		return Config{}, err
	}
	quotaDaily, err := envInt("YOUTUBE_QUOTA_DAILY_UNITS", 10_000)
	if err != nil {
		return Config{}, err
	}
	cfg.QuotaDailyUnits = int64(quotaDaily)

	pollCycleSeconds, err := envInt("YOUTUBE_POLL_CYCLE_SECONDS", 20)
	if err != nil {
		return Config{}, err
	}
	cfg.PollCycleInterval = time.Duration(pollCycleSeconds) * time.Second

	minDelayMillis, err := envInt("YOUTUBE_MIN_CHAT_POLL_DELAY_MS", 2000)
	if err != nil {
		return Config{}, err
	}
	cfg.MinChatPollDelay = time.Duration(minDelayMillis) * time.Millisecond

	return cfg, nil
}

func requiredEnv(name string) (string, error) {
	value := os.Getenv(name)
	if value == "" {
		return "", fmt.Errorf("missing required environment: %s", name)
	}
	return value, nil
}

func envString(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

// envBool reads a strict "true"/"false" (case-insensitive); anything else,
// including unset, returns fallback. There is no partial/typo tolerance —
// TipBotAckEnabled staying OFF by default must never be defeated by a
// malformed value being read as truthy.
func envBool(name string, fallback bool) bool {
	value := os.Getenv(name)
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "true":
		return true
	case "false":
		return false
	default:
		return fallback
	}
}

func envInt(name string, fallback int) (int, error) {
	value := os.Getenv(name)
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return 0, errors.New(name + " must be a positive integer")
	}
	return parsed, nil
}
