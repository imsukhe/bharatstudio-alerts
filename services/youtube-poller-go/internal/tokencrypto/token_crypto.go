// Package tokencrypto decrypts OAuth tokens written by
// apps/api/src/notifications/token-crypto.ts (NotificationTokenProtector).
// The ciphertext format is `v1.<iv>.<authTag>.<ciphertext>`, each segment
// base64url (no padding), AES-256-GCM with a 12-byte IV and a 16-byte GCM
// tag appended by Node as part of the encrypted output there and split back
// out here for Go's cipher.AEAD, which wants tag+ciphertext concatenated.
//
// This package only decrypts (and re-encrypts, for token refresh — the same
// key, so the write path stays byte-compatible with what the TypeScript API
// reads back). It never logs a token, fingerprint input, or key material.
package tokencrypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

const (
	formatVersion = "v1"
	nonceSize     = 12
	tagSize       = 16
)

var (
	ErrInvalidKey    = errors.New("token encryption key must be 64 hexadecimal characters (32 bytes)")
	ErrInvalidFormat = errors.New("token ciphertext is not in v1.<iv>.<tag>.<ciphertext> format")
)

// Protector mirrors NotificationTokenProtector: Fingerprint for lookup-safe
// hashing, Encrypt/Decrypt for the reversible v1 envelope.
type Protector struct {
	key []byte
}

// NewProtector parses a 64-hex-character AES-256 key, identical to
// keyFromHex() in token-crypto.ts.
func NewProtector(hexKey string) (*Protector, error) {
	if len(hexKey) != 64 {
		return nil, ErrInvalidKey
	}
	key, err := hex.DecodeString(hexKey)
	if err != nil || len(key) != 32 {
		return nil, ErrInvalidKey
	}
	return &Protector{key: key}, nil
}

// Fingerprint mirrors fingerprint(): sha256 of the raw UTF-8 token, hex
// encoded. Used only to compare against access_token_fingerprint /
// refresh_token_fingerprint — never to derive or verify decryption.
func (p *Protector) Fingerprint(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// Decrypt reverses Encrypt(): splits the v1 envelope, reassembles
// ciphertext||tag for Go's GCM Open, and returns the plaintext token.
func (p *Protector) Decrypt(envelope string) (string, error) {
	parts := strings.Split(envelope, ".")
	if len(parts) != 4 || parts[0] != formatVersion {
		return "", ErrInvalidFormat
	}
	iv, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || len(iv) != nonceSize {
		return "", fmt.Errorf("%w: bad iv", ErrInvalidFormat)
	}
	tag, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || len(tag) != tagSize {
		return "", fmt.Errorf("%w: bad tag", ErrInvalidFormat)
	}
	ciphertext, err := base64.RawURLEncoding.DecodeString(parts[3])
	if err != nil {
		return "", fmt.Errorf("%w: bad ciphertext", ErrInvalidFormat)
	}

	block, err := aes.NewCipher(p.key)
	if err != nil {
		return "", err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	sealed := append(append([]byte{}, ciphertext...), tag...)
	plaintext, err := aead.Open(nil, iv, sealed, nil)
	if err != nil {
		return "", fmt.Errorf("token decrypt: authentication failed: %w", err)
	}
	return string(plaintext), nil
}

// Encrypt mirrors encrypt(): a fresh random 12-byte IV per call, producing
// the same v1.<iv>.<tag>.<ciphertext> envelope the TypeScript API writes
// and reads. Used when this service persists a refreshed access/refresh
// token back to youtube_channel_connections.
func (p *Protector) Encrypt(token string) (string, error) {
	iv := make([]byte, nonceSize)
	if _, err := rand.Read(iv); err != nil {
		return "", err
	}
	block, err := aes.NewCipher(p.key)
	if err != nil {
		return "", err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	sealed := aead.Seal(nil, iv, []byte(token), nil)
	ciphertext := sealed[:len(sealed)-tagSize]
	tag := sealed[len(sealed)-tagSize:]
	return fmt.Sprintf("%s.%s.%s.%s",
		formatVersion,
		base64.RawURLEncoding.EncodeToString(iv),
		base64.RawURLEncoding.EncodeToString(tag),
		base64.RawURLEncoding.EncodeToString(ciphertext),
	), nil
}
