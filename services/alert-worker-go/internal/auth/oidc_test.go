package auth

import (
	"context"
	"errors"
	"net/http/httptest"
	"testing"
)

type fakeVerifier struct {
	token    string
	audience string
	err      error
}

func (v *fakeVerifier) Verify(_ context.Context, token, audience string) error {
	v.token = token
	v.audience = audience
	return v.err
}

func TestOIDCAuthorizerRequiresConfiguredVerifierAndAudience(t *testing.T) {
	request := httptest.NewRequest("POST", "/internal/tasks/alert", nil)
	if err := (OIDCAuthorizer{}).Authorize(request); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("error = %v, want ErrNotConfigured", err)
	}
}

func TestOIDCAuthorizerVerifiesBearerTokenForConfiguredAudience(t *testing.T) {
	verifier := &fakeVerifier{}
	authorizer := OIDCAuthorizer{Audience: "https://worker.example.test", Verifier: verifier}
	request := httptest.NewRequest("POST", "/internal/tasks/alert", nil)
	request.Header.Set("Authorization", "bearer signed-token")

	if err := authorizer.Authorize(request); err != nil {
		t.Fatalf("Authorize() error = %v", err)
	}
	if verifier.token != "signed-token" || verifier.audience != "https://worker.example.test" {
		t.Fatalf("verifier received token=%q audience=%q", verifier.token, verifier.audience)
	}
}

func TestOIDCAuthorizerRejectsMissingAndInvalidTokens(t *testing.T) {
	verifier := &fakeVerifier{err: errors.New("signature invalid")}
	authorizer := OIDCAuthorizer{Audience: "worker", Verifier: verifier}
	missing := httptest.NewRequest("POST", "/internal/tasks/alert", nil)
	if err := authorizer.Authorize(missing); !errors.Is(err, ErrMissingToken) {
		t.Fatalf("missing error = %v, want ErrMissingToken", err)
	}
	invalid := httptest.NewRequest("POST", "/internal/tasks/alert", nil)
	invalid.Header.Set("Authorization", "Bearer bad")
	if err := authorizer.Authorize(invalid); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("invalid error = %v, want ErrInvalidToken", err)
	}
}
