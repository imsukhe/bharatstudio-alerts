package auth

import (
	"context"
	"errors"
	"strings"

	"google.golang.org/api/idtoken"
)

var ErrMissingAudience = errors.New("missing oidc audience")

type GoogleTokenVerifier struct {
	validator *idtoken.Validator
	audience  string
}

func NewGoogleTokenVerifier(ctx context.Context, audience string) (*GoogleTokenVerifier, error) {
	audience = strings.TrimSpace(audience)
	if audience == "" {
		return nil, ErrMissingAudience
	}
	validator, err := idtoken.NewValidator(ctx)
	if err != nil {
		return nil, err
	}
	return &GoogleTokenVerifier{validator: validator, audience: audience}, nil
}

func (v *GoogleTokenVerifier) Verify(ctx context.Context, token, audience string) error {
	if v == nil || v.validator == nil || audience == "" || audience != v.audience {
		return ErrInvalidToken
	}
	if _, err := v.validator.Validate(ctx, token, audience); err != nil {
		return ErrInvalidToken
	}
	return nil
}
