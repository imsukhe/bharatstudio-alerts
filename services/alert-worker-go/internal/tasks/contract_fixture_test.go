package tasks

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

// JSON-schema validation runs in the repository contract validator. This
// check makes the committed language-neutral fixture executable by the Go
// producer/consumer as well, so envelope drift fails locally.
func TestCloudTaskCommandMatchesCommittedV1Fixture(t *testing.T) {
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("could not locate test source")
	}
	fixturePath := filepath.Join(filepath.Dir(sourceFile), "..", "..", "..", "..", "contracts", "fixtures", "cloud-task-command.json")
	raw, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatalf("read command fixture: %v", err)
	}
	var command Command
	if err := json.Unmarshal(raw, &command); err != nil {
		t.Fatalf("decode command fixture: %v", err)
	}
	if err := command.Validate(time.Date(2026, 8, 15, 10, 0, 1, 0, time.UTC)); err != nil {
		t.Fatalf("Go command rejected committed v1 fixture: %v", err)
	}
	if command.CreatedAt.IsZero() || command.Deadline.IsZero() || !command.Deadline.After(command.CreatedAt) {
		t.Fatalf("fixture lost command lifecycle timestamps: %+v", command)
	}
}
