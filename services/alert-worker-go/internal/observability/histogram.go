package observability

import (
	"fmt"
	"io"
	"math"
)

// Histogram is a minimal, dependency-free bucketed histogram (RT-06,
// FULL-PRODUCT-DEFINITION.md section 19.0/19.4). Deliberately not the
// cumulative Prometheus wire representation internally -- Counts[i] holds
// the number of observations that fell in (Buckets[i-1], Buckets[i]]
// (first-fit against ascending boundaries), not a running cumulative sum.
// That keeps two things simple and directly testable:
//
//  1. RT-06.2 (arithmetic correctness) -- a known set of observations
//     produces an exact, checkable Counts slice with no cumulative-sum
//     arithmetic in the way.
//  2. RT-06.4 (cross-instance additive aggregation) -- two independent
//     Counts slices sum elementwise (MergeHistograms) into the
//     arithmetically correct combined histogram. This is the local, provable
//     half of "aggregated across instances": Prometheus's own cross-instance
//     story is `sum by (le) (rate(x_bucket[...]))` over the cumulative wire
//     format, additive for exactly this reason. Proving the wire format
//     itself round-trips a real Prometheus/Cloud Monitoring aggregation
//     needs a deployed scrape target this process cannot stand up -- see
//     bharatstudio-requirements/reviews/2026-09-16-rt-06-budget-histograms.md.
//
// The cumulative `_bucket{le=...}` line Prometheus expects is computed only
// at render time (WritePrometheus), from a running prefix sum over Counts.
//
// Not internally synchronized: every Histogram field this package owns
// (Metrics.pumpDuration) is only ever touched while the owning Metrics' own
// mutex is held (see metrics.go's Observe/WritePrometheus) -- the same
// discipline every other Metrics field already follows. A Histogram used
// outside that discipline needs its own lock at the call site.
type Histogram struct {
	Buckets []float64 // ascending boundary values in ms; +Inf is implicit and not stored
	Counts  []uint64  // Counts[i] = observations in (Buckets[i-1], Buckets[i]]; same length as Buckets
	Sum     float64
	Count   uint64
}

func NewHistogram(buckets []float64) *Histogram {
	return &Histogram{Buckets: buckets, Counts: make([]uint64, len(buckets))}
}

// Observe never panics. A metrics failure must never delay, drop or alter a
// request (RT-06.6) -- this only ever mutates its own in-memory counters,
// performs no I/O, and defensively floors a pathological duration (NaN,
// negative, +Inf) to zero rather than propagating anything.
func (h *Histogram) Observe(valueMs float64) {
	if h == nil {
		return
	}
	value := valueMs
	if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 {
		value = 0
	}
	h.Count++
	h.Sum += value
	for index, boundary := range h.Buckets {
		if value <= boundary {
			h.Counts[index]++
			return
		}
	}
	// Exceeds every finite boundary: counted in Count/Sum (and therefore the
	// rendered +Inf bucket) but no finite bucket slot.
}

// MergeHistograms proves RT-06.4's additive property directly: two
// independently observed histograms over the same bucket boundaries sum
// elementwise into the arithmetically correct combined histogram.
func MergeHistograms(a, b *Histogram) (*Histogram, error) {
	if a == nil || b == nil {
		return nil, fmt.Errorf("cannot merge a nil histogram")
	}
	if len(a.Buckets) != len(b.Buckets) {
		return nil, fmt.Errorf("cannot merge histograms with different bucket counts")
	}
	for index := range a.Buckets {
		if a.Buckets[index] != b.Buckets[index] {
			return nil, fmt.Errorf("cannot merge histograms with different bucket boundaries")
		}
	}
	merged := NewHistogram(a.Buckets)
	for index := range a.Counts {
		merged.Counts[index] = a.Counts[index] + b.Counts[index]
	}
	merged.Sum = a.Sum + b.Sum
	merged.Count = a.Count + b.Count
	return merged, nil
}

// EstimateQuantile is the standard linear-interpolation-within-the-
// containing-bucket estimate (the same method Prometheus's own
// histogram_quantile uses): it assumes observations are uniformly
// distributed across the width of whichever bucket the target rank falls
// in. That is an estimate, not an exact value -- its error is bounded by
// the width of that one bucket, which is exactly why every section-19.4
// budget number is placed as an exact bucket boundary (RT-06 scope rule):
// CI checks the boundary bucket's own cumulative count directly, an exact,
// non-interpolated fact, never this estimate. The second return value is
// false only when the histogram has no observations. If the target rank
// falls in the +Inf bucket, there is no finite upper bound to interpolate
// against; the last finite boundary is returned as a lower-bound-only
// indicator, not the estimate's usual bucket-width bound.
func (h *Histogram) EstimateQuantile(quantile float64) (float64, bool) {
	if h == nil || h.Count == 0 {
		return 0, false
	}
	target := quantile * float64(h.Count)
	var cumulative float64
	lower := 0.0
	for index, boundary := range h.Buckets {
		bucketCount := float64(h.Counts[index])
		if cumulative+bucketCount >= target && bucketCount > 0 {
			fraction := (target - cumulative) / bucketCount
			return lower + fraction*(boundary-lower), true
		}
		cumulative += bucketCount
		lower = boundary
	}
	if len(h.Buckets) > 0 {
		return h.Buckets[len(h.Buckets)-1], true
	}
	return 0, false
}

// WritePrometheus renders the standard Prometheus histogram exposition
// shape: cumulative `_bucket{le=...}` lines (including the implicit +Inf
// bucket), `_sum`, and `_count`.
func (h *Histogram) WritePrometheus(w io.Writer, name, help string) {
	if h == nil {
		return
	}
	_, _ = fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s histogram\n", name, help, name)
	var cumulative uint64
	for index, boundary := range h.Buckets {
		cumulative += h.Counts[index]
		_, _ = fmt.Fprintf(w, "%s_bucket{le=\"%s\"} %d\n", name, formatBoundary(boundary), cumulative)
	}
	_, _ = fmt.Fprintf(w, "%s_bucket{le=\"+Inf\"} %d\n", name, h.Count)
	_, _ = fmt.Fprintf(w, "%s_sum %.3f\n", name, h.Sum)
	_, _ = fmt.Fprintf(w, "%s_count %d\n", name, h.Count)
}

// writeQuantileGauge emits the RT-06 section-3.2 p95/p99 read-out for one
// histogram, with HELP text stating the estimate's bound explicitly -- it
// is never presented as an exact value.
func writeQuantileGauge(w io.Writer, baseName string, h *Histogram) {
	p95, _ := h.EstimateQuantile(0.95)
	p99, _ := h.EstimateQuantile(0.99)
	_, _ = fmt.Fprintf(w, "# HELP %s_p95_estimate Bucket-interpolated p95 estimate; bounded by the containing bucket's width, not exact. 0 when no observations exist.\n# TYPE %s_p95_estimate gauge\n%s_p95_estimate %.3f\n", baseName, baseName, baseName, p95)
	_, _ = fmt.Fprintf(w, "# HELP %s_p99_estimate Bucket-interpolated p99 estimate; bounded by the containing bucket's width, not exact. 0 when no observations exist.\n# TYPE %s_p99_estimate gauge\n%s_p99_estimate %.3f\n", baseName, baseName, baseName, p99)
}

func formatBoundary(boundaryMs float64) string {
	if boundaryMs == math.Trunc(boundaryMs) {
		return fmt.Sprintf("%d", int64(boundaryMs))
	}
	return fmt.Sprintf("%.3f", boundaryMs)
}
