package observability

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestStructuredLoggerOmitsInvalidTraceAndUntrustedTokens(t *testing.T) {
	var output bytes.Buffer
	logger := NewStructuredLogger(&output)
	logger.Event("task", "accepted", "razorpay:event-1")
	logger.Event("task", "queue id secret", "trace\nsecret")

	lines := strings.Split(strings.TrimSpace(output.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("log lines=%d output=%q", len(lines), output.String())
	}
	var first map[string]string
	if err := json.Unmarshal([]byte(lines[0]), &first); err != nil {
		t.Fatal(err)
	}
	if first["component"] != "task" || first["outcome"] != "accepted" || first["trace_id"] != "razorpay:event-1" {
		t.Fatalf("unexpected structured record: %#v", first)
	}
	if strings.Contains(output.String(), "secret") {
		t.Fatalf("untrusted data leaked into structured logs: %q", output.String())
	}
}
