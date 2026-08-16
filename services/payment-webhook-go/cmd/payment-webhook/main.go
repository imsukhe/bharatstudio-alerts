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

	"github.com/bharatstudio/bharatstudio-alerts/services/payment-webhook-go/internal/auth"
	"github.com/bharatstudio/bharatstudio-alerts/services/payment-webhook-go/internal/checkout"
	"github.com/bharatstudio/bharatstudio-alerts/services/payment-webhook-go/internal/db"
	"github.com/bharatstudio/bharatstudio-alerts/services/payment-webhook-go/internal/ingress"
	"github.com/bharatstudio/bharatstudio-alerts/services/payment-webhook-go/internal/observability"
	"github.com/bharatstudio/bharatstudio-alerts/services/payment-webhook-go/internal/provider"
	"github.com/bharatstudio/bharatstudio-alerts/services/payment-webhook-go/internal/reconcile"
	"github.com/bharatstudio/bharatstudio-alerts/services/payment-webhook-go/internal/subscription"
	"google.golang.org/api/idtoken"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	environment, err := requiredEnv("PAYMENT_ENVIRONMENT")
	if err != nil {
		return err
	}
	if environment != "test" && environment != "live" {
		return errors.New("PAYMENT_ENVIRONMENT must be test or live")
	}
	privateAudience, err := requiredEnv("PAYMENT_PRIVATE_AUDIENCE")
	if err != nil {
		return err
	}
	webhookSecret, err := requiredEnv("RAZORPAY_WEBHOOK_SECRET")
	if err != nil {
		return err
	}
	keyID, err := requiredEnv("RAZORPAY_KEY_ID")
	if err != nil {
		return err
	}
	keySecret, err := requiredEnv("RAZORPAY_KEY_SECRET")
	if err != nil {
		return err
	}
	dsn, err := requiredEnv("PAYMENT_DATABASE_URL")
	if err != nil {
		return err
	}
	workerPumpURL, err := requiredEnv("ALERT_WORKER_PUMP_URL")
	if err != nil {
		return err
	}
	workerPumpAudience, err := requiredEnv("ALERT_WORKER_PUMP_AUDIENCE")
	if err != nil {
		return err
	}
	workerConfiguredAudience, err := requiredEnv("ALERT_WORKER_PRIVATE_AUDIENCE")
	if err != nil {
		return err
	}
	if err := validateWorkerAudience(workerPumpAudience, workerConfiguredAudience); err != nil {
		return err
	}
	paymentMaxOpen, err := envInt("PAYMENT_DB_MAX_OPEN", 8)
	if err != nil {
		return err
	}
	paymentMaxIdle, err := envInt("PAYMENT_DB_MAX_IDLE", 8)
	if err != nil {
		return err
	}
	reconciliationBatchSize, err := envInt("PAYMENT_RECONCILIATION_BATCH_SIZE", 50)
	if err != nil {
		return err
	}
	refundReconciliationBatchSize, err := envInt("PAYMENT_REFUND_RECONCILIATION_BATCH_SIZE", 50)
	if err != nil {
		return err
	}

	database, err := db.Open(ctx, db.Config{DSN: dsn, MaxOpenConns: paymentMaxOpen, MaxIdleConns: paymentMaxIdle})
	if err != nil {
		return fmt.Errorf("open payment database: %w", err)
	}
	defer database.Close()

	orders, err := provider.NewRazorpayClient(os.Getenv("RAZORPAY_API_BASE_URL"), keyID, keySecret, nil)
	if err != nil {
		return fmt.Errorf("configure razorpay client: %w", err)
	}
	store, err := ingress.NewSQLStore(database, environment)
	if err != nil {
		return fmt.Errorf("configure payment store: %w", err)
	}
	workerHTTPClient, err := idtoken.NewClient(ctx, workerPumpAudience)
	if err != nil {
		return fmt.Errorf("configure worker pump identity: %w", err)
	}
	workerPumper, err := ingress.NewWorkerPumpClient(workerHTTPClient, workerPumpURL)
	if err != nil {
		return fmt.Errorf("configure worker pump: %w", err)
	}
	checkoutService := checkout.NewService(store, orders)
	subscriptionCatalog := subscription.EnvironmentCatalog(environment)
	subscriptionService := subscription.NewService(store, orders, subscriptionCatalog)
	subscriptionLifecycleService := subscription.NewLifecycleService(store, orders, orders, subscriptionCatalog)
	googleVerifier, err := auth.NewGoogleTokenVerifier(ctx, privateAudience)
	if err != nil {
		return fmt.Errorf("configure private oidc verifier: %w", err)
	}
	privateAuthorizer := auth.OIDCAuthorizer{Audience: privateAudience, Verifier: googleVerifier}
	reconciliationStore, err := reconcile.NewSQLStore(database)
	if err != nil {
		return fmt.Errorf("configure reconciliation store: %w", err)
	}
	metrics := observability.New()
	logger := observability.NewStructuredLogger(os.Stdout)
	reconciliationHandler := reconcile.HTTPHandler{
		Authorizer: privateAuthorizer,
		Runner: reconcile.Runner{
			Store:            reconciliationStore,
			Provider:         orders,
			RecoveryProvider: orders,
			RecoveryStore:    store,
		},
		Limit: reconciliationBatchSize, Metrics: metrics,
	}
	refundReconciliationHandler := reconcile.RefundHTTPHandler{
		Authorizer: privateAuthorizer,
		Runner:     reconcile.RefundRunner{Store: reconciliationStore, Provider: orders},
		Limit:      refundReconciliationBatchSize, Metrics: metrics,
	}

	mux := http.NewServeMux()
	mux.Handle("/v1/webhooks/razorpay", ingress.Handler{Secret: webhookSecret, Store: store, Pumper: workerPumper, Metrics: metrics, Logger: logger})
	mux.Handle("/internal/v1/tips/orders", checkout.HTTPHandler{Authorizer: privateAuthorizer, Service: checkoutService, Environment: environment, Metrics: metrics})
	mux.Handle("/internal/v1/subscriptions", subscription.HTTPHandler{Authorizer: privateAuthorizer, Service: subscriptionService, Environment: environment})
	mux.Handle("/internal/v1/subscriptions/lifecycle", subscription.LifecycleHTTPHandler{Authorizer: privateAuthorizer, Service: subscriptionLifecycleService, Environment: environment})
	mux.Handle("/internal/v1/reconciliation/payments", reconciliationHandler)
	mux.Handle("/internal/v1/reconciliation/refunds", refundReconciliationHandler)
	mux.Handle("/internal/metrics", metrics.Endpoint(privateAuthorizer.Authorize))
	mux.HandleFunc("/healthz", func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"status":"ok","service":"bharatstudio-payment-webhook"}`))
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
	log.Printf("payment service listening on %s environment=%s", server.Addr, environment)
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
