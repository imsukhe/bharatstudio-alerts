package chatcommand

import (
	"errors"
	"testing"
)

func amt(v int64) *int64 { return &v }

func TestParseTipCommand(t *testing.T) {
	cases := []struct {
		name       string
		input      string
		wantAmount *int64
		wantMsg    string
		wantErr    error
	}{
		{"bare command", "!tip", nil, "", nil},
		{"bare command trailing space", "!tip   ", nil, "", nil},
		{"amount only", "!tip 100", amt(100), "", nil},
		{"amount and message", "!tip 100 message here", amt(100), "message here", nil},
		{"uppercase", "!TIP 100 hello", amt(100), "hello", nil},
		{"mixed case", "!tIp 50 gg", amt(50), "gg", nil},
		{"leading/trailing whitespace on whole message", "   !tip 100 gg  ", amt(100), "gg", nil},
		{"multiple spaces collapse before amount", "!tip    100    hi there", amt(100), "hi there", nil},
		{"message keeps internal double spaces", "!tip 100 hi   there", amt(100), "hi   there", nil},
		{"minimum amount", "!tip 1", amt(1), "", nil},
		{"maximum amount", "!tip 100000", amt(100000), "", nil},

		// Negative: must NOT trigger at all.
		{"mid-sentence mention", "check out !tip 10", nil, "", ErrNotACommand},
		{"lookalike command", "!tipjar 10", nil, "", ErrNotACommand},
		{"unrelated message", "hello everyone", nil, "", ErrNotACommand},
		{"empty message", "", nil, "", ErrNotACommand},
		{"command with no separator before text", "!tips 10", nil, "", ErrNotACommand},
		{"punctuation right after token", "!tip!100", nil, "", ErrNotACommand},

		// Negative: invokes !tip but is malformed — rejected, not coerced.
		{"decimal amount", "!tip 10.50", nil, "", ErrMalformedAmount},
		{"currency symbol", "!tip ₹100", nil, "", ErrMalformedAmount},
		{"thousands separator", "!tip 1,000", nil, "", ErrMalformedAmount},
		{"negative sign", "!tip -10", nil, "", ErrMalformedAmount},
		{"positive sign", "!tip +10", nil, "", ErrMalformedAmount},
		{"word amount", "!tip lots please", nil, "", ErrMalformedAmount},
		{"leading zero", "!tip 0100", nil, "", ErrMalformedAmount},
		{"zero amount", "!tip 0", nil, "", ErrAmountTooSmall},
		{"too many digits", "!tip 1000000", nil, "", ErrMalformedAmount},
		{"amount above max", "!tip 100001", nil, "", ErrAmountTooLarge},
		{"message too long", "!tip 10 " + repeat("x", 201), nil, "", ErrMessageTooLong},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ParseTipCommand(tc.input)
			if tc.wantErr != nil {
				if !errors.Is(err, tc.wantErr) {
					t.Fatalf("input %q: got err %v, want %v", tc.input, err, tc.wantErr)
				}
				if got != nil {
					t.Fatalf("input %q: expected nil TipIntent on error, got %+v", tc.input, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("input %q: unexpected error %v", tc.input, err)
			}
			if got == nil {
				t.Fatalf("input %q: expected a TipIntent, got nil", tc.input)
			}
			if (tc.wantAmount == nil) != (got.AmountRupees == nil) {
				t.Fatalf("input %q: amount presence mismatch, got %v want %v", tc.input, got.AmountRupees, tc.wantAmount)
			}
			if tc.wantAmount != nil && *got.AmountRupees != *tc.wantAmount {
				t.Fatalf("input %q: got amount %d, want %d", tc.input, *got.AmountRupees, *tc.wantAmount)
			}
			if got.Message != tc.wantMsg {
				t.Fatalf("input %q: got message %q, want %q", tc.input, got.Message, tc.wantMsg)
			}
		})
	}
}

func repeat(s string, n int) string {
	out := make([]byte, 0, n*len(s))
	for i := 0; i < n; i++ {
		out = append(out, s...)
	}
	return string(out)
}
