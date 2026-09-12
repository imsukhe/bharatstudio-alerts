package tokencrypto

import (
	"strings"
	"testing"
)

// syntheticKey is a synthetic, non-secret fixture key — never a real
// deployed value.
const syntheticKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd12"

func TestRoundTrip(t *testing.T) {
	protector, err := NewProtector(syntheticKey)
	if err != nil {
		t.Fatalf("NewProtector() error = %v", err)
	}
	token := "synthetic-refresh-token-value"

	envelope, err := protector.Encrypt(token)
	if err != nil {
		t.Fatalf("Encrypt() error = %v", err)
	}
	if !strings.HasPrefix(envelope, "v1.") {
		t.Fatalf("Encrypt() = %q, want v1.<iv>.<tag>.<ciphertext> format", envelope)
	}
	if parts := strings.Split(envelope, "."); len(parts) != 4 {
		t.Fatalf("Encrypt() produced %d dot-separated segments, want 4: %q", len(parts), envelope)
	}

	decrypted, err := protector.Decrypt(envelope)
	if err != nil {
		t.Fatalf("Decrypt() error = %v", err)
	}
	if decrypted != token {
		t.Fatalf("Decrypt() = %q, want %q", decrypted, token)
	}
}

func TestFingerprintIsStableAndDoesNotRevealToken(t *testing.T) {
	protector, err := NewProtector(syntheticKey)
	if err != nil {
		t.Fatalf("NewProtector() error = %v", err)
	}
	a := protector.Fingerprint("token-a")
	b := protector.Fingerprint("token-a")
	c := protector.Fingerprint("token-b")
	if a != b {
		t.Fatalf("Fingerprint() not stable: %q != %q", a, b)
	}
	if a == c {
		t.Fatalf("Fingerprint() collided for distinct tokens")
	}
	if strings.Contains(a, "token-a") {
		t.Fatalf("Fingerprint() leaked the input token")
	}
}

func TestDecryptRejectsTamperedCiphertext(t *testing.T) {
	protector, err := NewProtector(syntheticKey)
	if err != nil {
		t.Fatalf("NewProtector() error = %v", err)
	}
	envelope, err := protector.Encrypt("synthetic-token")
	if err != nil {
		t.Fatalf("Encrypt() error = %v", err)
	}
	parts := strings.Split(envelope, ".")
	// Flip the last character of the ciphertext segment.
	last := []rune(parts[3])
	if last[len(last)-1] == 'A' {
		last[len(last)-1] = 'B'
	} else {
		last[len(last)-1] = 'A'
	}
	parts[3] = string(last)
	tampered := strings.Join(parts, ".")

	if _, err := protector.Decrypt(tampered); err == nil {
		t.Fatal("Decrypt() accepted tampered ciphertext, want authentication failure")
	}
}

func TestDecryptRejectsMalformedEnvelope(t *testing.T) {
	protector, err := NewProtector(syntheticKey)
	if err != nil {
		t.Fatalf("NewProtector() error = %v", err)
	}
	cases := []string{
		"",
		"not-an-envelope",
		"v2.aaaa.bbbb.cccc",
		"v1.onlythreeparts.bbbb",
	}
	for _, envelope := range cases {
		if _, err := protector.Decrypt(envelope); err == nil {
			t.Fatalf("Decrypt(%q) accepted malformed envelope", envelope)
		}
	}
}

func TestNewProtectorRejectsBadKey(t *testing.T) {
	cases := []string{"", "too-short", strings.Repeat("g", 64)}
	for _, key := range cases {
		if _, err := NewProtector(key); err == nil {
			t.Fatalf("NewProtector(%q) accepted an invalid key", key)
		}
	}
}
