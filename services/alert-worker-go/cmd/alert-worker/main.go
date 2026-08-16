package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/bharatstudio/bharatstudio-alerts/services/alert-worker-go/internal/auth"
	"github.com/bharatstudio/bharatstudio-alerts/services/alert-worker-go/internal/db"
	"github.com/bharatstudio/bharatstudio-alerts/services/alert-worker-go/internal/handler"
	"github.com/bharatstudio/bharatstudio-alerts/services/alert-worker-go/internal/observability"
	"github.com/bharatstudio/bharatstudio-alerts/services/alert-worker-go/internal/store"
	"github.com/bharatstudio/bharatstudio-alerts/services/alert-worker-go/internal/tasks"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	dsn, err := requiredEnv("ALERT_WORKER_DATABASE_URL")
	if err != nil {
		return err
	}
	audience, err := requiredEnv("ALERT_WORKER_PRIVATE_AUDIENCE")
	if err != nil {
		return err
	}
	pumpAudience, err := requiredEnv("ALERT_WORKER_PUMP_AUDIENCE")
	if err != nil {
		return err
	}
	if err := validateWorkerAudience(pumpAudience, audience); err != nil {
		return err
	}
	maxOpen, err := envInt("ALERT_WORKER_DB_MAX_OPEN", 8)
	if err != nil {
		return err
	}
	maxIdle, err := envInt("ALERT_WORKER_DB_MAX_IDLE", 8)
	if err != nil {
		return err
	}
	pumpConcurrency, err := envInt("ALERT_WORKER_PUMP_CONCURRENCY", 8)
	if err != nil {
		return err
	}
	queue, err := requiredEnv("ALERT_WORKER_CLOUD_TASKS_QUEUE")
	if err != nil {
		return err
	}
	taskTargetURL, err := requiredEnv("ALERT_WORKER_TASK_TARGET_URL")
	if err != nil {
		return err
	}
	taskServiceAccount, err := requiredEnv("ALERT_WORKER_TASK_SERVICE_ACCOUNT")
	if err != nil {
		return err
	}

	database, err := db.Open(ctx, db.Config{DSN: dsn, MaxOpenConns: maxOpen, MaxIdleConns: maxIdle})
	if err != nil {
		return fmt.Errorf("open alert worker database: %w", err)
	}
	defer database.Close()
	cloudTasksClient, err := tasks.NewGoogleCloudTasksClient(ctx)
	if err != nil {
		return fmt.Errorf("configure cloud tasks client: %w", err)
	}
	defer cloudTasksClient.Close()
	enqueuer, err := tasks.NewEnqueuer(cloudTasksClient, queue, taskTargetURL, audience, taskServiceAccount)
	if err != nil {
		return fmt.Errorf("configure cloud tasks enqueuer: %w", err)
	}

	verifier, err := auth.NewGoogleTokenVerifier(ctx, audience)
	if err != nil {
		return fmt.Errorf("configure private oidc verifier: %w", err)
	}
	authorizer := auth.OIDCAuthorizer{Audience: audience, Verifier: verifier}
	deliveryStore := store.NewSQLDeliveryStore(database)
	readyStore := store.NewSQLReadyDeliveryStore(database)
	notifier := store.NewSQLWakeupNotifier(database)
	publisher := handler.NewDurableReplayPublisher()
	metrics := observability.New()
	logger := observability.NewStructuredLogger(os.Stdout)
	cloudTaskHandler := handler.New(handler.Config{
		Authorizer:    authorizer,
		Store:         deliveryStore,
		Publisher:     publisher,
		Notifier:      notifier,
		LeaseDuration: 30 * time.Second,
		RetryDelay:    5 * time.Second,
		Metrics:       metrics,
		Logger:        logger,
	})
	pumpHandler := handler.NewPumpHandler(handler.PumpConfig{
		Authorizer:  authorizer,
		Source:      readyStore,
		Enqueuer:    enqueuer,
		Concurrency: pumpConcurrency,
		Metrics:     metrics,
	})

	mux := http.NewServeMux()
	mux.Handle("/internal/v1/tasks/overlay", cloudTaskHandler)
	mux.Handle("/internal/v1/tasks/pump", pumpHandler)
	mux.Handle("/internal/metrics", metrics.Endpoint(authorizer.Authorize))
	mux.HandleFunc("/healthz", func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"status":"ok","service":"bharatstudio-alert-worker"}`))
	})
	mux.Handle("/readyz", observability.ReadinessHandler(database.PingContext))

	server := &http.Server{
		Addr:              ":" + envString("PORT", "8080"),
		Handler:           observability.Instrument(mux, metrics),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	log.Printf("alert worker listening on %s", server.Addr)
	shutdownContext, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	serverErrors := make(chan error, 1)
	go func() { serverErrors <- server.ListenAndServe() }()
	select {
	case err := <-serverErrors:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-shutdownContext.Done():
		graceContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return server.Shutdown(graceContext)
	}
}

func validateWorkerAudience(pumpAudience, configuredAudience string) error {
	if pumpAudience == "" || configuredAudience == "" || pumpAudience != configuredAudience {
		return errors.New("ALERT_WORKER_PUMP_AUDIENCE must match ALERT_WORKER_PRIVATE_AUDIENCE")
	}
	return nil
}

func requiredEnv(name string) (string, error) {
	value := os.Getenv(name)
	if value == "" {
		return "", errors.New("missing required environment: " + name)
	}
	return value, nil
}

func envString(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func envInt(name string, fallback int) (int, error) {
	value := os.Getenv(name)
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer", name)
	}
	return parsed, nil
}
