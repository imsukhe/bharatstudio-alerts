package auth

import (
	"context"
	"errors"
	"testing"
)

func TestNewGoogleTokenVerifierRequiresAudience(t *testing.T) {
	_, err := NewGoogleTokenVerifier(context.Background(), "")
	if !errors.Is(err, ErrMissingAudience) {
		t.Fatalf("error = %v, want ErrMissingAudience", err)
	}
}

func TestNilGoogleTokenVerifierFailsClosed(t *testing.T) {
	if err := (*GoogleTokenVerifier)(nil).Verify(context.Background(), "token", "audience"); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("error = %v, want ErrInvalidToken", err)
	}
}
