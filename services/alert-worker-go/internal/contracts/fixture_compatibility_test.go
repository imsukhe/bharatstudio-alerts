package contracts

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/google/uuid"
)

type deliveryFixture struct {
	SchemaVersion         string         `json:"schemaVersion"`
	EventID               string         `json:"eventId"`
	QueueID               string         `json:"queueId"`
	DeliveryID            string         `json:"deliveryId"`
	SourceID              string         `json:"sourceId"`
	BindingID             string         `json:"bindingId"`
	ConfigSnapshotVersion int            `json:"configSnapshotVersion"`
	Status                string         `json:"status"`
	DeliverySequence      int            `json:"deliverySequence"`
	SourcePriority        int            `json:"sourcePriority"`
	OverrideValues        map[string]any `json:"overrideValues"`
	AttemptCount          int            `json:"attemptCount"`
	NextActionAt          *time.Time     `json:"nextActionAt"`
	LastErrorCode         *string        `json:"lastErrorCode"`
}

type multiQueueFixture struct {
	Schema        string            `json:"$schema"`
	SchemaVersion string            `json:"schemaVersion"`
	EventID       string            `json:"eventId"`
	ChannelID     string            `json:"channelId"`
	SourceType    string            `json:"sourceType"`
	SourceID      string            `json:"sourceId"`
	BindingID     string            `json:"bindingId"`
	Deliveries    []deliveryFixture `json:"deliveries"`
	Expected      struct {
		QueueBMayProgressWhileQueueAIsHeld bool `json:"queueBMayProgressWhileQueueAIsHeld"`
		GlobalEventStatusMayBlockQueueB    bool `json:"globalEventStatusMayBlockQueueB"`
	} `json:"expected"`
}

type queueDeliveryFixture struct {
	Schema string `json:"$schema"`
	deliveryFixture
}

type overlayEventFixture struct {
	SchemaVersion string         `json:"schemaVersion"`
	Schema        string         `json:"$schema"`
	Cursor        string         `json:"cursor"`
	EventID       string         `json:"eventId"`
	EventType     string         `json:"eventType"`
	TraceID       string         `json:"traceId"`
	CreatedAt     time.Time      `json:"createdAt"`
	Payload       map[string]any `json:"payload"`
}

type paymentDeliveryFixture struct {
	Schema              string    `json:"$schema"`
	SchemaVersion       string    `json:"schemaVersion"`
	Provider            string    `json:"provider"`
	Environment         string    `json:"environment"`
	ConnectedAccountRef string    `json:"connectedAccountRef"`
	ProviderEventID     string    `json:"providerEventId"`
	EntityType          string    `json:"entityType"`
	EntityID            string    `json:"entityId"`
	RawBodyHash         *string   `json:"rawBodyHash"`
	SignatureVerifiedAt time.Time `json:"signatureVerifiedAt"`
	ReceivedAt          time.Time `json:"receivedAt"`
}

func fixtureRoot(t *testing.T) string {
	t.Helper()
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("could not locate fixture compatibility test")
	}
	return filepath.Join(filepath.Dir(source), "..", "..", "..", "..", "contracts", "fixtures")
}

func readStrictFixture[T any](t *testing.T, name string, target *T) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(fixtureRoot(t), name))
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		t.Fatalf("decode %s with strict Go contract: %v", name, err)
	}
}

func requireUUID(t *testing.T, label, value string) {
	t.Helper()
	if _, err := uuid.Parse(value); err != nil {
		t.Fatalf("%s is not a UUID: %q", label, value)
	}
}

func requireSchema(t *testing.T, got, want string) {
	t.Helper()
	if got != "https://contracts.bharatstudio.invalid/v1/"+want {
		t.Fatalf("schema is %q, want v1/%s", got, want)
	}
}

func validateDelivery(t *testing.T, delivery deliveryFixture) {
	t.Helper()
	if delivery.SchemaVersion != "v1" || delivery.ConfigSnapshotVersion < 1 || delivery.DeliverySequence < 1 || delivery.SourcePriority < 0 || delivery.OverrideValues == nil {
		t.Fatalf("invalid delivery contract: %+v", delivery)
	}
	for label, value := range map[string]string{
		"delivery.eventId":    delivery.EventID,
		"delivery.queueId":    delivery.QueueID,
		"delivery.deliveryId": delivery.DeliveryID,
		"delivery.bindingId":  delivery.BindingID,
	} {
		requireUUID(t, label, value)
	}
	if delivery.SourceID == "" || delivery.Status == "" {
		t.Fatalf("delivery lost required source/status: %+v", delivery)
	}
}

func TestCommittedRuntimeFixturesRemainCompatibleWithGoConsumers(t *testing.T) {
	t.Run("multi queue", func(t *testing.T) {
		var fixture multiQueueFixture
		readStrictFixture(t, "multi-queue-delivery.json", &fixture)
		requireSchema(t, fixture.Schema, "multi-queue-delivery.schema.json")
		if fixture.SchemaVersion != "v1" || len(fixture.Deliveries) != 2 || !fixture.Expected.QueueBMayProgressWhileQueueAIsHeld || fixture.Expected.GlobalEventStatusMayBlockQueueB {
			t.Fatalf("multi-queue independence contract changed: %+v", fixture.Expected)
		}
		requireUUID(t, "multi-queue.eventId", fixture.EventID)
		requireUUID(t, "multi-queue.channelId", fixture.ChannelID)
		requireUUID(t, "multi-queue.bindingId", fixture.BindingID)
		for index, delivery := range fixture.Deliveries {
			validateDelivery(t, delivery)
			if delivery.EventID != fixture.EventID || delivery.BindingID != fixture.BindingID || delivery.SourceID != fixture.SourceID {
				t.Fatalf("delivery %d lost parent source identity", index)
			}
		}
		if fixture.Deliveries[0].Status != "held" || fixture.Deliveries[1].Status != "ready" || fixture.Deliveries[0].SourcePriority >= fixture.Deliveries[1].SourcePriority {
			t.Fatalf("multi-queue priority/status fixture changed: %+v", fixture.Deliveries)
		}
	})

	t.Run("per queue delivery", func(t *testing.T) {
		var fixture queueDeliveryFixture
		readStrictFixture(t, "queue-delivery.json", &fixture)
		requireSchema(t, fixture.Schema, "queue-delivery.schema.json")
		validateDelivery(t, fixture.deliveryFixture)
		if fixture.AttemptCount < 0 || fixture.Status != "ready" || fixture.NextActionAt != nil || fixture.LastErrorCode != nil {
			t.Fatalf("queue delivery retry projection changed: %+v", fixture)
		}
	})

	t.Run("overlay SSE", func(t *testing.T) {
		var fixture overlayEventFixture
		readStrictFixture(t, "overlay-sse-event.json", &fixture)
		requireSchema(t, fixture.Schema, "overlay-sse-event.schema.json")
		if fixture.SchemaVersion != "v1" || fixture.Cursor == "" || fixture.TraceID == "" || fixture.EventType != "alert.ready" || fixture.Payload == nil || fixture.CreatedAt.IsZero() {
			t.Fatalf("overlay event contract changed: %+v", fixture)
		}
		requireUUID(t, "overlay.eventId", fixture.EventID)
		for _, field := range []string{"deliveryId", "queueId", "bindingId"} {
			value, ok := fixture.Payload[field].(string)
			if !ok {
				t.Fatalf("overlay payload %s is not a string UUID", field)
			}
			requireUUID(t, "overlay.payload."+field, value)
		}
	})

	t.Run("payment webhook", func(t *testing.T) {
		var fixture paymentDeliveryFixture
		readStrictFixture(t, "payment-webhook-delivery.json", &fixture)
		requireSchema(t, fixture.Schema, "payment-webhook-delivery.schema.json")
		if fixture.SchemaVersion != "v1" || fixture.Provider != "razorpay" || fixture.Environment != "test" || fixture.ConnectedAccountRef == "" || fixture.ProviderEventID == "" || fixture.EntityID == "" || fixture.SignatureVerifiedAt.IsZero() || fixture.ReceivedAt.IsZero() {
			t.Fatalf("payment delivery contract changed: %+v", fixture)
		}
	})
}

func TestCommittedRuntimeFixturesRejectUnknownFields(t *testing.T) {
	var fixture queueDeliveryFixture
	raw := []byte(`{"$schema":"https://contracts.bharatstudio.invalid/v1/queue-delivery.schema.json","schemaVersion":"v1","eventId":"00000000-0000-4000-8000-000000000011","queueId":"00000000-0000-4000-8000-000000000004","deliveryId":"00000000-0000-4000-8000-000000000012","sourceId":"pay_test_002","bindingId":"00000000-0000-4000-8000-000000000003","configSnapshotVersion":1,"deliverySequence":1,"sourcePriority":50,"overrideValues":{},"status":"ready","attemptCount":0,"nextActionAt":null,"lastErrorCode":null,"unexpected":"must-fail"}`)
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&fixture); err == nil {
		t.Fatal("strict Go fixture consumer accepted an unknown field")
	}
}
