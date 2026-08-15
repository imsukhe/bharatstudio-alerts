package db

import (
	"context"
	"errors"
	"testing"
)

func TestOpenFailsClosedWithoutDSN(t *testing.T) {
	if _, err := Open(context.Background(), Config{}); !errors.Is(err, ErrMissingDSN) {
		t.Fatalf("error = %v", err)
	}
}
