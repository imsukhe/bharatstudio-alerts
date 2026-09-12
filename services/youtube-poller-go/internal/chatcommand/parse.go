// Package chatcommand parses YouTube live-chat text messages into a
// TipIntent (master plan Part 6, L15 task 7 / 10.3 item 17). It is a new,
// standalone package: it plugs into the existing poller flow
// (internal/domain/live_event.go normalises the raw chat message; a caller
// outside this package feeds that text here) and does not replace or call
// into it. This file does no I/O, reads no config, and creates no
// TipIntent record — it only decides whether a message invoked !tip and,
// if so, what amount/message the viewer asked for.
package chatcommand

import (
	"errors"
	"strconv"
	"strings"
	"unicode"
)

// TipIntent is the result of successfully parsing a `!tip` command.
// AmountRupees is nil when the viewer typed bare `!tip` with no amount —
// this package never invents a default amount; that is a server-side
// decision (the channel's minimum tip) made later, outside this package.
type TipIntent struct {
	AmountRupees *int64
	Message      string
}

var (
	// ErrNotACommand means the message never invoked !tip at all — this is
	// the overwhelmingly common case for ordinary chat text, including a
	// message that merely mentions "!tip" after other words, or a
	// lookalike token like "!tipjar". Callers must treat this as silence,
	// never surface it to chat, and never confuse it with a malformed
	// command below.
	ErrNotACommand = errors.New("chatcommand: message does not invoke !tip")
	// ErrMalformedAmount covers anything that is not a plain, unsigned,
	// no-leading-zero base-10 integer in the first token after !tip:
	// decimals ("!tip 10.50"), currency symbols ("!tip ₹100", "!tip $10"),
	// thousands separators ("!tip 1,000"), signs ("!tip -10", "!tip +10"),
	// words ("!tip lots"), and leading zeros ("!tip 0100"). The amount is
	// rejected outright rather than coerced into "the digits found".
	ErrMalformedAmount = errors.New("chatcommand: !tip amount is not a plain positive integer")
	// ErrAmountTooSmall / ErrAmountTooLarge reject absurd amounts (zero,
	// or unrealistically large) rather than clamping them to a bound.
	ErrAmountTooSmall = errors.New("chatcommand: !tip amount is below the minimum")
	ErrAmountTooLarge = errors.New("chatcommand: !tip amount exceeds the maximum")
	// ErrMessageTooLong rejects an oversized message rather than
	// truncating it, so a caller can tell the viewer why nothing happened.
	ErrMessageTooLong = errors.New("chatcommand: !tip message exceeds the maximum length")
)

const (
	commandToken = "!tip"

	// MinAmountRupees/MaxAmountRupees bound what this parser accepts.
	// MaxAmountRupees intentionally sits well below any real payment
	// provider ceiling — a chat-typed amount this large is far more
	// likely to be a mis-type or an abuse attempt than a genuine tip, and
	// this package's job is to reject that outright, not guess.
	MinAmountRupees = 1
	MaxAmountRupees = 100000
	// MaxMessageRunes bounds the optional message text.
	MaxMessageRunes = 200
	// maxAmountDigits guards against overflow/absurdly long digit strings
	// before strconv.ParseInt ever runs — six digits comfortably covers
	// MaxAmountRupees (100000) with one digit to spare.
	maxAmountDigits = 6
)

// ParseTipCommand parses one chat message. It returns (nil, ErrNotACommand)
// when the message does not invoke !tip. It returns (nil, <specific err>)
// when the message clearly invokes !tip but the amount or message is
// malformed. It returns (*TipIntent, nil) only for input this package is
// willing to accept as-is — never a coerced or best-effort reading of bad
// input.
func ParseTipCommand(raw string) (*TipIntent, error) {
	trimmed := strings.TrimSpace(raw)
	rest, ok := stripCommandToken(trimmed)
	if !ok {
		return nil, ErrNotACommand
	}
	rest = strings.TrimLeftFunc(rest, unicode.IsSpace)
	if rest == "" {
		return &TipIntent{}, nil
	}

	amountText, remainder := splitFirstToken(rest)
	amount, err := parseAmount(amountText)
	if err != nil {
		return nil, err
	}
	message := strings.TrimFunc(remainder, unicode.IsSpace)
	if len([]rune(message)) > MaxMessageRunes {
		return nil, ErrMessageTooLong
	}
	value := amount
	return &TipIntent{AmountRupees: &value, Message: message}, nil
}

// stripCommandToken reports whether trimmed begins with "!tip" as a whole
// token (case-insensitive: "!TIP", "!Tip", "!tIp" all match) — i.e.
// followed by whitespace or end of string, never by another non-space
// character. This is what keeps "!tipjar" and "please use !tip 10" from
// triggering: the former fails the word-boundary check, the latter fails
// because !tip must lead the (trimmed) message, not appear mid-sentence.
func stripCommandToken(trimmed string) (string, bool) {
	if len(trimmed) < len(commandToken) {
		return "", false
	}
	if !strings.EqualFold(trimmed[:len(commandToken)], commandToken) {
		return "", false
	}
	rest := trimmed[len(commandToken):]
	if rest != "" && !unicode.IsSpace(rune(rest[0])) {
		return "", false
	}
	return rest, true
}

// splitFirstToken splits s on its first run of whitespace into the leading
// token and everything after that one whitespace run, preserving any
// internal spacing in the remainder (a message may legitimately contain
// multiple consecutive spaces).
func splitFirstToken(s string) (token string, remainder string) {
	idx := strings.IndexFunc(s, unicode.IsSpace)
	if idx == -1 {
		return s, ""
	}
	end := idx
	for end < len(s) && unicode.IsSpace(rune(s[end])) {
		end++
	}
	return s[:idx], s[end:]
}

func parseAmount(text string) (int64, error) {
	if text == "" || len(text) > maxAmountDigits {
		return 0, ErrMalformedAmount
	}
	for _, r := range text {
		if r < '0' || r > '9' {
			return 0, ErrMalformedAmount
		}
	}
	if len(text) > 1 && text[0] == '0' {
		// No leading zeros: "0100" is rejected outright, never coerced to 100.
		return 0, ErrMalformedAmount
	}
	value, err := strconv.ParseInt(text, 10, 64)
	if err != nil {
		return 0, ErrMalformedAmount
	}
	if value < MinAmountRupees {
		return 0, ErrAmountTooSmall
	}
	if value > MaxAmountRupees {
		return 0, ErrAmountTooLarge
	}
	return value, nil
}
