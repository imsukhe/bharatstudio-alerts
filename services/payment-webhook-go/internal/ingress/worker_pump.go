package ingress

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

const maxPumpResponseBytes int64 = 16 << 10
const defaultWorkerPumpTimeout = 5 * time.Second

// WorkerPumpClient calls the private alert-worker pump. Authentication is
// provided by Google's ID-token client in production; tests can inject an
// ordinary HTTP client without credentials.
type WorkerPumpClient struct {
	client   *http.Client
	endpoint string
	timeout  time.Duration
}

func NewWorkerPumpClient(client *http.Client, endpoint string) (WorkerPumpClient, error) {
	return NewWorkerPumpClientWithTimeout(client, endpoint, defaultWorkerPumpTimeout)
}

func NewWorkerPumpClientWithTimeout(client *http.Client, endpoint string, timeout time.Duration) (WorkerPumpClient, error) {
	parsed, err := url.Parse(endpoint)
	if client == nil || err != nil || parsed.Scheme != "https" || parsed.Host == "" || timeout <= 0 {
		return WorkerPumpClient{}, errors.New("invalid worker pump configuration")
	}
	boundedClient := *client
	if boundedClient.Timeout <= 0 || timeout < boundedClient.Timeout {
		boundedClient.Timeout = timeout
	}
	return WorkerPumpClient{client: &boundedClient, endpoint: endpoint, timeout: timeout}, nil
}

func (c WorkerPumpClient) Pump(ctx context.Context) error {
	if c.client == nil || c.endpoint == "" {
		return errors.New("worker pump is not configured")
	}
	timeout := c.timeout
	if timeout <= 0 {
		timeout = defaultWorkerPumpTimeout
	}
	pumpContext, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(pumpContext, http.MethodPost, c.endpoint, bytes.NewReader([]byte("{}")))
	if err != nil {
		return fmt.Errorf("create worker pump request: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	if traceID := traceIDFromContext(ctx); traceID != "" {
		request.Header.Set(traceHeader, traceID)
	}
	response, err := c.client.Do(request)
	if err != nil {
		return fmt.Errorf("call worker pump: %w", err)
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maxPumpResponseBytes))
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return fmt.Errorf("worker pump returned status %d", response.StatusCode)
	}
	return nil
}
