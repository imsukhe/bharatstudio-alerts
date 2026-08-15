package observability

import (
	"encoding/json"
	"io"
	"strings"
	"sync"
	"time"
)

// StructuredLogger emits only bounded operational fields. It intentionally
// has no generic map/error argument, preventing task, queue, payment and user
// payloads from being attached to worker logs by accident.
type StructuredLogger struct {
	mu     sync.Mutex
	writer io.Writer
	now    func() time.Time
}

func NewStructuredLogger(writer io.Writer) *StructuredLogger {
	return &StructuredLogger{writer: writer, now: time.Now}
}

func (l *StructuredLogger) Event(component, outcome, traceID string) {
	if l == nil || l.writer == nil {
		return
	}
	record := map[string]string{
		"time":      l.now().UTC().Format(time.RFC3339Nano),
		"component": boundedToken(component),
		"outcome":   boundedToken(outcome),
	}
	if normalized := boundedTrace(traceID); normalized != "" {
		record["trace_id"] = normalized
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	_ = json.NewEncoder(l.writer).Encode(record)
}

func boundedTrace(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 128 {
		return ""
	}
	for _, char := range value {
		if (char < 'a' || char > 'z') && (char < 'A' || char > 'Z') &&
			(char < '0' || char > '9') && char != '-' && char != '_' && char != '.' && char != ':' {
			return ""
		}
	}
	return value
}

func boundedToken(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 64 {
		return "other"
	}
	for _, char := range value {
		if (char < 'a' || char > 'z') && (char < 'A' || char > 'Z') &&
			(char < '0' || char > '9') && char != '-' && char != '_' && char != '.' {
			return "other"
		}
	}
	return value
}
