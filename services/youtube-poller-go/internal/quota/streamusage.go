package quota

import "sync"

// StreamUsage records observable signals about liveChatMessages.streamList
// connections, per channel. It exists because Google does not publish a
// per-call unit cost for streamList (see CostLiveChatMessagesStreamList's
// own doc comment) — this is what lets an operator correlate connect
// counts and message throughput here against the actual quota drawdown
// Google Cloud Console reports once this runs against a real, metered
// project, rather than trusting an assumed number. StreamUsage itself
// draws no conclusion about the true unit cost; it only counts.
type StreamUsage struct {
	mu    sync.Mutex
	stats map[string]*channelStreamStats
}

// ChannelStreamStats is a point-in-time copy of one channel's counters.
type ChannelStreamStats struct {
	Connects int64
	Messages int64
}

type channelStreamStats struct {
	connects int64
	messages int64
}

func NewStreamUsage() *StreamUsage {
	return &StreamUsage{stats: make(map[string]*channelStreamStats)}
}

// RecordConnect counts one successful streamList connect (including a
// reconnect after a drop) for channelID.
func (u *StreamUsage) RecordConnect(channelID string) {
	if u == nil {
		return
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	u.entryLocked(channelID).connects++
}

// RecordMessages counts n messages received on channelID's stream.
func (u *StreamUsage) RecordMessages(channelID string, n int) {
	if u == nil || n <= 0 {
		return
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	u.entryLocked(channelID).messages += int64(n)
}

func (u *StreamUsage) entryLocked(channelID string) *channelStreamStats {
	s, ok := u.stats[channelID]
	if !ok {
		s = &channelStreamStats{}
		u.stats[channelID] = s
	}
	return s
}

// Snapshot returns a copy of every channel's counters for logging or
// metrics export.
func (u *StreamUsage) Snapshot() map[string]ChannelStreamStats {
	if u == nil {
		return nil
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	out := make(map[string]ChannelStreamStats, len(u.stats))
	for k, v := range u.stats {
		out[k] = ChannelStreamStats{Connects: v.connects, Messages: v.messages}
	}
	return out
}
