package observability

import (
	"math"
	"strings"
	"sync"
	"testing"
	"time"
)

// RT-06.2: a known set of observations yields the arithmetically correct
// bucket counts.
func TestHistogramObserveProducesExactBucketCounts(t *testing.T) {
	h := NewHistogram([]float64{10, 25, 50, 100})
	values := []float64{5, 9, 10, 15, 24, 50, 51, 90, 100, 250}
	for _, v := range values {
		h.Observe(v)
	}
	// (0,10]: 5,9,10 -> 3   (10,25]: 15,24 -> 2   (25,50]: 50 -> 1
	// (50,100]: 51,90,100 -> 3   >100 (+Inf only): 250 -> 1
	want := []uint64{3, 2, 1, 3}
	for i, w := range want {
		if h.Counts[i] != w {
			t.Fatalf("bucket %d (le=%v): got %d want %d (counts=%v)", i, h.Buckets[i], h.Counts[i], w, h.Counts)
		}
	}
	if h.Count != uint64(len(values)) {
		t.Fatalf("total count = %d, want %d", h.Count, len(values))
	}
}

// RT-06.6: a pathological duration (NaN, negative, +Inf) never panics and is
// clamped to zero rather than corrupting the histogram or the caller.
func TestHistogramObserveNeverPanicsOnPathologicalInput(t *testing.T) {
	h := NewHistogram([]float64{10, 20})
	for _, v := range []float64{math.NaN(), math.Inf(1), math.Inf(-1), -5, -0.0001} {
		h.Observe(v) // must not panic
	}
	if h.Count != 5 {
		t.Fatalf("count = %d, want 5 (every observation must still be counted)", h.Count)
	}
	if h.Counts[0] != 5 {
		t.Fatalf("all clamped-to-zero observations must land in the first bucket, got counts=%v", h.Counts)
	}
	var nilHistogram *Histogram
	nilHistogram.Observe(10) // must not panic on a nil receiver either
	if _, ok := nilHistogram.EstimateQuantile(0.99); ok {
		t.Fatalf("a nil histogram must report no observations")
	}
}

// RT-06.3: the p95/p99 read-out is correct for a known distribution, and its
// documented error bound (the estimate lies within the bucket that actually
// contains the true value) holds.
func TestEstimateQuantileMatchesKnownDistributionWithinItsBucketBound(t *testing.T) {
	// 100 observations: 95 at 10ms, 5 at 100ms. True p95 (nearest-rank,
	// position 95 of 100) = 10ms, in bucket (0,10]. True p99 (position 99)
	// falls among the last 5, all 100ms, in bucket (75,100].
	h := NewHistogram([]float64{10, 25, 50, 75, 100, 200})
	for i := 0; i < 95; i++ {
		h.Observe(10)
	}
	for i := 0; i < 5; i++ {
		h.Observe(100)
	}
	p95, ok := h.EstimateQuantile(0.95)
	if !ok {
		t.Fatalf("expected an estimate")
	}
	if p95 < 0 || p95 > 10 {
		t.Fatalf("p95 estimate %v escaped the bound of the bucket containing the true value ([0,10])", p95)
	}
	p99, ok := h.EstimateQuantile(0.99)
	if !ok {
		t.Fatalf("expected an estimate")
	}
	if p99 < 75 || p99 > 100 {
		t.Fatalf("p99 estimate %v escaped the bound of the bucket containing the true value ([75,100])", p99)
	}
}

func TestEstimateQuantileOnEmptyHistogramReportsNoObservations(t *testing.T) {
	h := NewHistogram([]float64{10, 20})
	if _, ok := h.EstimateQuantile(0.99); ok {
		t.Fatalf("an empty histogram must report no observations, not a fabricated estimate")
	}
}

// RT-06.4: per-instance histograms sum correctly -- the additive property
// cross-instance aggregation depends on.
func TestMergeHistogramsIsArithmeticallyAdditive(t *testing.T) {
	a := NewHistogram([]float64{10, 20, 30})
	a.Observe(5)
	a.Observe(15)
	a.Observe(15)
	b := NewHistogram([]float64{10, 20, 30})
	b.Observe(5)
	b.Observe(25)
	b.Observe(100)

	merged, err := MergeHistograms(a, b)
	if err != nil {
		t.Fatalf("unexpected error merging identically-bucketed histograms: %v", err)
	}
	want := []uint64{2, 2, 1}
	for i, w := range want {
		if merged.Counts[i] != w {
			t.Fatalf("merged bucket %d = %d, want %d (merged=%v)", i, merged.Counts[i], w, merged.Counts)
		}
	}
	if merged.Count != a.Count+b.Count {
		t.Fatalf("merged count %d != sum of inputs %d", merged.Count, a.Count+b.Count)
	}
	if merged.Sum != a.Sum+b.Sum {
		t.Fatalf("merged sum %v != sum of inputs %v", merged.Sum, a.Sum+b.Sum)
	}
}

func TestMergeHistogramsRejectsMismatchedBuckets(t *testing.T) {
	a := NewHistogram([]float64{10, 20})
	b := NewHistogram([]float64{10, 30})
	if _, err := MergeHistograms(a, b); err == nil {
		t.Fatalf("expected an error merging histograms with different bucket boundaries")
	}
}

// RT-06.1: every section-19.4 budget a path carries appears as an exact
// bucket boundary for that path. This service's own pump path carries no
// explicit section-19.4 duration number of its own (see metrics.go's
// readClassBucketsMs comment) -- it is measured under the read-class
// bucket set, whose 200 boundary is section 19.4's own "API reads < 200ms"
// figure.
func TestPumpPathCarriesTheReadClassBoundary(t *testing.T) {
	m := New()
	var output strings.Builder
	m.WritePrometheus(&output)
	body := output.String()
	if !strings.Contains(body, `bsa_worker_pump_duration_ms_bucket{le="200"}`) {
		t.Fatalf("missing read-class 200ms boundary in: %s", body)
	}
}

// RT-06.5: labels stay bounded and low-cardinality -- this histogram
// carries zero labels (the metric name alone identifies the path), so no
// delivery, event, channel or payment identifier can reach it.
func TestPumpHistogramCarriesNoIdentifyingLabels(t *testing.T) {
	m := New()
	m.Observe("POST", "/internal/v1/tasks/pump", 200, 42*time.Millisecond)
	var output strings.Builder
	m.WritePrometheus(&output)
	body := output.String()
	for _, line := range strings.Split(body, "\n") {
		if strings.HasPrefix(line, "bsa_worker_pump_duration_ms") {
			if strings.Contains(line, "{") && !strings.Contains(line, `le=`) {
				t.Fatalf("pump histogram line carries an unexpected label: %q", line)
			}
		}
	}
}

// RT-06.9: Go -race clean on the new shared histogram state under
// concurrent Observe/WritePrometheus (every field access happens under
// Metrics.mu, same as every pre-existing field).
func TestHistogramIsRaceCleanUnderConcurrentObserveAndScrape(t *testing.T) {
	m := New()
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			m.Observe("POST", "/internal/v1/tasks/pump", 200, time.Duration(n)*time.Millisecond)
			var discard strings.Builder
			m.WritePrometheus(&discard)
		}(i)
	}
	wg.Wait()
}
