package auth

import (
	"context"
	"errors"
	"net/http"
	"strings"
)

var (
	ErrNotConfigured = errors.New("oidc authorizer not configured")
	ErrMissingToken  = errors.New("missing bearer token")
	ErrInvalidToken  = errors.New("invalid bearer token")
)

type TokenVerifier interface {
	Verify(ctx context.Context, token, audience string) error
}

type OIDCAuthorizer struct {
	Audience string
	Verifier TokenVerifier
}

func (a OIDCAuthorizer) Authorize(request *http.Request) error {
	if a.Verifier == nil || strings.TrimSpace(a.Audience) == "" {
		return ErrNotConfigured
	}
	parts := strings.Fields(strings.TrimSpace(request.Header.Get("Authorization")))
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") || parts[1] == "" {
		return ErrMissingToken
	}
	if err := a.Verifier.Verify(request.Context(), parts[1], a.Audience); err != nil {
		return ErrInvalidToken
	}
	return nil
}
