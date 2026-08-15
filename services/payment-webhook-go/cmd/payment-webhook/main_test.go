package main

import (
	"strings"
	"testing"
)

func TestRunFailsClosedWithoutPanicWhenRequiredConfigurationIsMissing(t *testing.T) {
	for _, name := range []string{
		"PAYMENT_ENVIRONMENT",
		"PAYMENT_PRIVATE_AUDIENCE",
		"RAZORPAY_WEBHOOK_SECRET",
		"RAZORPAY_KEY_ID",
		"RAZORPAY_KEY_SECRET",
		"PAYMENT_DATABASE_URL",
		"ALERT_WORKER_PUMP_URL",
		"ALERT_WORKER_PUMP_AUDIENCE",
	} {
		t.Setenv(name, "")
	}

	if err := run(); err == nil || !strings.Contains(err.Error(), "missing required environment: PAYMENT_ENVIRONMENT") {
		t.Fatalf("run() error = %v, want bounded missing-environment error", err)
	}
}

func TestRequiredEnvAndEnvIntReturnErrorsInsteadOfPanicking(t *testing.T) {
	t.Setenv("BSA_TEST_REQUIRED", "")
	if _, err := requiredEnv("BSA_TEST_REQUIRED"); err == nil {
		t.Fatal("requiredEnv should reject an empty value")
	}

	t.Setenv("BSA_TEST_INT", "invalid")
	if _, err := envInt("BSA_TEST_INT", 8); err == nil {
		t.Fatal("envInt should reject an invalid value")
	}

	t.Setenv("BSA_TEST_INT", "")
	value, err := envInt("BSA_TEST_INT", 8)
	if err != nil || value != 8 {
		t.Fatalf("envInt fallback = (%d, %v), want (8, nil)", value, err)
	}
}
