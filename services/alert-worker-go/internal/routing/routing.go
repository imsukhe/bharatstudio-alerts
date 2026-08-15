package routing

import (
	"sort"
	"time"
)

// Binding is the worker-facing projection returned by the reviewed
// resolve_queue_bindings database function. The worker receives only active
// bindings for one channel/source lookup.
type Binding struct {
	BindingID       string
	QueueID         string
	SourceType      string
	SourceID        string
	AllowDuplicates bool
	Priority        int
	OverrideValues  map[string]any
	CreatedAt       time.Time
}

type DeliveryPlan struct {
	BindingID       string
	QueueID         string
	SourceType      string
	SourceID        string
	AllowDuplicates bool
	Priority        int
	OverrideValues  map[string]any
}

// Resolve performs source correlation before priority ordering. Every
// matching permitted queue receives its own plan, so a later dispatcher can
// create independent durable outbox-delivery rows and advance them separately.
// It does not mutate the input bindings or their override maps.
func Resolve(sourceType, sourceID string, bindings []Binding) []DeliveryPlan {
	matching := make([]Binding, 0, len(bindings))
	for _, binding := range bindings {
		if binding.SourceType == sourceType && binding.SourceID == sourceID {
			matching = append(matching, binding)
		}
	}
	sort.SliceStable(matching, func(i, j int) bool {
		if matching[i].Priority != matching[j].Priority {
			return matching[i].Priority > matching[j].Priority
		}
		if !matching[i].CreatedAt.Equal(matching[j].CreatedAt) {
			return matching[i].CreatedAt.Before(matching[j].CreatedAt)
		}
		return matching[i].BindingID < matching[j].BindingID
	})

	plans := make([]DeliveryPlan, 0, len(matching))
	for _, binding := range matching {
		overrides := make(map[string]any, len(binding.OverrideValues))
		for key, value := range binding.OverrideValues {
			overrides[key] = value
		}
		plans = append(plans, DeliveryPlan{
			BindingID:       binding.BindingID,
			QueueID:         binding.QueueID,
			SourceType:      binding.SourceType,
			SourceID:        binding.SourceID,
			AllowDuplicates: binding.AllowDuplicates,
			Priority:        binding.Priority,
			OverrideValues:  overrides,
		})
	}
	return plans
}
