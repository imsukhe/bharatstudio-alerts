package ingress

import (
	"context"
	"strings"
)

const traceHeader = "X-BSA-Trace-Id"

type traceContextKey struct{}

func withTraceID(ctx context.Context, traceID string) context.Context {
	if normalized := normalizeTraceID(traceID); normalized != "" {
		return context.WithValue(ctx, traceContextKey{}, normalized)
	}
	return ctx
}

func traceIDFromContext(ctx context.Context) string {
	value, _ := ctx.Value(traceContextKey{}).(string)
	return normalizeTraceID(value)
}

func traceForProviderEvent(eventID string) string {
	return "razorpay:" + eventID
}

func normalizeTraceID(value string) string {
	value = strings.TrimSpace(value)
	if len(value) == 0 || len(value) > 128 {
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
