package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/bharatstudio/bharatstudio-alerts/services/youtube-poller-go/internal/config"
	"github.com/bharatstudio/bharatstudio-alerts/services/youtube-poller-go/internal/db"
	"github.com/bharatstudio/bharatstudio-alerts/services/youtube-poller-go/internal/observability"
	"github.com/bharatstudio/bharatstudio-alerts/services/youtube-poller-go/internal/poller"
	"github.com/bharatstudio/bharatstudio-alerts/services/youtube-poller-go/internal/quota"
	"github.com/bharatstudio/bharatstudio-alerts/services/youtube-poller-go/internal/store"
	"github.com/bharatstudio/bharatstudio-alerts/services/youtube-poller-go/internal/tipintent"
	"github.com/bharatstudio/bharatstudio-alerts/services/youtube-poller-go/internal/tokencrypto"
	"github.com/bharatstudio/bharatstudio-alerts/services/youtube-poller-go/internal/youtube"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	openCtx, cancelOpen := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelOpen()
	database, err := db.Open(openCtx, db.Config{
		DSN:          cfg.DatabaseURL,
		MaxOpenConns: cfg.DatabaseMaxOpenConns,
		MaxIdleConns: cfg.DatabaseMaxIdleConns,
	})
	if err != nil {
		return err
	}
	defer database.Close()

	protector, err := tokencrypto.NewProtector(cfg.TokenEncryptionKey)
	if err != nil {
		return err
	}

	client := youtube.NewClient(nil, cfg.YoutubeAPIBaseURL, cfg.YoutubeTokenURL)
	budget := quota.NewBudget(cfg.QuotaDailyUnits, time.Now)

	pollerConfig := poller.Config{
		Client:            client,
		Connections:       store.NewConnectionsStore(database),
		Events:            store.NewEventStore(database),
		Protector:         protector,
		DB:                database,
		Budget:            budget,
		ClientID:          cfg.GoogleClientID,
		ClientSecret:      cfg.GoogleClientSecret,
		PollCycleInterval: cfg.PollCycleInterval,
		MinChatPollDelay:  cfg.MinChatPollDelay,
		// StreamUsage records streamList connect/message counts per
		// channel purely for post-hoc quota-cost correlation against
		// Google Cloud Console once this runs against a live, metered
		// project — see internal/quota.CostLiveChatMessagesStreamList.
		StreamUsage: quota.NewStreamUsage(),
		// ChatPoster is always wired (it is the same YouTube client used
		// for discovery/polling); TipBotAckEnabled is what actually gates
		// whether it is ever called — see config.Config.TipBotAckEnabled's
		// own doc comment for why that must default to false.
		ChatPoster:       client,
		TipBotAckEnabled: cfg.TipBotAckEnabled,
	}

	// TipIntents/TipIntentDedup are only wired up when both the service URL
	// and secret are configured — see config.Config.TipIntentServiceURL's
	// own doc comment: this lets the poller run in environments that have
	// not provisioned the connector secret yet, rather than hard-failing at
	// startup. Left unset (nil interface, not a typed-nil pointer) rather
	// than always assigning a possibly-nil *tipintent.Client/
	// *store.TipIntentDedupStore, which would leave poller.Config holding a
	// non-nil interface wrapping a nil pointer and defeat its own
	// `p.TipIntents == nil` checks.
	if cfg.TipIntentServiceURL != "" && cfg.TipIntentServiceSecret != "" {
		pollerConfig.TipIntents = tipintent.NewClient(nil, cfg.TipIntentServiceURL, cfg.TipIntentServiceSecret)
		pollerConfig.TipIntentDedup = store.NewTipIntentDedupStore(database)
	}

	p := poller.New(pollerConfig)

	logger := observability.NewStructuredLogger(os.Stdout)
	logger.Event("startup", "ok", "")

	runCtx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go p.RunForever(runCtx, log.Default())

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"status":"ok","service":"bharatstudio-youtube-poller"}`))
	})
	mux.Handle("/readyz", observability.ReadinessHandler(database.PingContext))

	server := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	serverErrors := make(chan error, 1)
	go func() { serverErrors <- server.ListenAndServe() }()

	select {
	case err := <-serverErrors:
		if err == http.ErrServerClosed {
			return nil
		}
		return err
	case <-runCtx.Done():
		shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancelShutdown()
		return server.Shutdown(shutdownCtx)
	}
}
