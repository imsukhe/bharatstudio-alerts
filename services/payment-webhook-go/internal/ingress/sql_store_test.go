package ingress

import (
	"regexp"
	"testing"
)

func TestRecoveryProviderEventIDUsesDatabaseSafeDeterministicFormat(t *testing.T) {
	first := recoveryProviderEventID("order_recovery_1", "pay_recovery_1")
	second := recoveryProviderEventID("order_recovery_1", "pay_recovery_1")
	if first != second {
		t.Fatalf("recovery event key is not deterministic: %q != %q", first, second)
	}
	if !regexp.MustCompile(`^[A-Za-z0-9._-]{1,200}$`).MatchString(first) {
		t.Fatalf("recovery event key is not database-safe: %q", first)
	}
}
