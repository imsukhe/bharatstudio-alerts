package routing

import (
	"reflect"
	"testing"
	"time"
)

func TestResolveCorrelatesSourceBeforePriorityAndPreservesEachQueue(t *testing.T) {
	created := time.Date(2026, 8, 14, 10, 0, 0, 0, time.UTC)
	plans := Resolve("payment", "pay_1", []Binding{
		{BindingID: "binding-low", QueueID: "queue-b", SourceType: "payment", SourceID: "pay_1", AllowDuplicates: true, Priority: 10, CreatedAt: created, OverrideValues: map[string]any{"style": "secondary"}},
		{BindingID: "binding-other", QueueID: "queue-x", SourceType: "payment", SourceID: "pay_2", Priority: 100, CreatedAt: created},
		{BindingID: "binding-high", QueueID: "queue-a", SourceType: "payment", SourceID: "pay_1", Priority: 20, CreatedAt: created, OverrideValues: map[string]any{"style": "primary", "durationMs": 4200}},
	})

	if len(plans) != 2 {
		t.Fatalf("plan count = %d, want 2", len(plans))
	}
	if plans[0].QueueID != "queue-a" || plans[1].QueueID != "queue-b" {
		t.Fatalf("queue order = %q, %q", plans[0].QueueID, plans[1].QueueID)
	}
	if !reflect.DeepEqual(plans[0].OverrideValues, map[string]any{"style": "primary", "durationMs": 4200}) {
		t.Fatalf("primary overrides = %#v", plans[0].OverrideValues)
	}
	if plans[1].OverrideValues["style"] != "secondary" {
		t.Fatalf("secondary override = %#v", plans[1].OverrideValues)
	}
}

func TestResolveUsesStableTieBreakers(t *testing.T) {
	created := time.Date(2026, 8, 14, 10, 0, 0, 0, time.UTC)
	plans := Resolve("manual", "source-1", []Binding{
		{BindingID: "b-2", QueueID: "q-2", SourceType: "manual", SourceID: "source-1", Priority: 5, CreatedAt: created},
		{BindingID: "b-1", QueueID: "q-1", SourceType: "manual", SourceID: "source-1", Priority: 5, CreatedAt: created},
	})
	if plans[0].BindingID != "b-1" || plans[1].BindingID != "b-2" {
		t.Fatalf("tie order = %q, %q", plans[0].BindingID, plans[1].BindingID)
	}
}

func TestResolveDoesNotShareMutableOverrideMap(t *testing.T) {
	original := map[string]any{"style": "primary"}
	plans := Resolve("payment", "pay_1", []Binding{{BindingID: "b-1", QueueID: "q-1", SourceType: "payment", SourceID: "pay_1", OverrideValues: original}})
	plans[0].OverrideValues["style"] = "changed"
	if original["style"] != "primary" {
		t.Fatal("routing mutated the binding override map")
	}
}
