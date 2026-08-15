package observability

import (
	"context"
	"net/http"
	"time"
)

// ReadinessHandler reports dependency readiness, not process liveness. The
// probe is injected so the runtime and its contract can be tested without a
// live database.
func ReadinessHandler(ping func(context.Context) error) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet {
			response.Header().Set("Allow", http.MethodGet)
			response.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		probeContext, probeCancel := context.WithTimeout(request.Context(), 2*time.Second)
		defer probeCancel()
		if err := ping(probeContext); err != nil {
			response.Header().Set("Content-Type", "application/json")
			response.WriteHeader(http.StatusServiceUnavailable)
			_, _ = response.Write([]byte(`{"status":"not_ready","reason":"database_unavailable"}`))
			return
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"status":"ready"}`))
	})
}
