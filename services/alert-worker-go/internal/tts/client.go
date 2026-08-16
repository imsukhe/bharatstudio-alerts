package tts

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"golang.org/x/oauth2"
	"google.golang.org/api/idtoken"
)

var ErrInvalidClient = errors.New("invalid TTS client")

type Enricher interface {
	Enrich(context.Context, string) error
}

type Client struct {
	endpoint    string
	tokenSource oauth2.TokenSource
	httpClient  *http.Client
}

func NewClient(ctx context.Context, endpoint, audience string, httpClient *http.Client) (Client, error) {
	if strings.TrimSpace(endpoint) == "" || strings.TrimSpace(audience) == "" {
		return Client{}, ErrInvalidClient
	}
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		return Client{}, ErrInvalidClient
	}
	source, err := idtoken.NewTokenSource(ctx, audience)
	if err != nil {
		return Client{}, fmt.Errorf("create TTS OIDC token source: %w", err)
	}
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 2500 * time.Millisecond}
	}
	return Client{endpoint: strings.TrimRight(endpoint, "/"), tokenSource: source, httpClient: httpClient}, nil
}

func NewClientWithTokenSource(endpoint string, source oauth2.TokenSource, httpClient *http.Client) (Client, error) {
	if strings.TrimSpace(endpoint) == "" || source == nil {
		return Client{}, ErrInvalidClient
	}
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		return Client{}, ErrInvalidClient
	}
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 2500 * time.Millisecond}
	}
	return Client{endpoint: strings.TrimRight(endpoint, "/"), tokenSource: source, httpClient: httpClient}, nil
}

func (c Client) Enrich(ctx context.Context, eventID string) error {
	if c.tokenSource == nil || c.httpClient == nil || strings.TrimSpace(eventID) == "" {
		return ErrInvalidClient
	}
	token, err := c.tokenSource.Token()
	if err != nil {
		return fmt.Errorf("get TTS OIDC token: %w", err)
	}
	body, err := json.Marshal(map[string]string{"eventId": eventID})
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint+"/internal/v1/tts/events/"+url.PathEscape(eventID), bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+token.AccessToken)
	request.Header.Set("Content-Type", "application/json")
	response, err := c.httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("TTS enrichment returned HTTP %d", response.StatusCode)
	}
	return nil
}

var _ Enricher = Client{}
