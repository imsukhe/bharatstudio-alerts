//go:build integration

// Package store integration test — the L15 gap this closes: "NO
// INTEGRATION TEST. Everything is in-memory fakes; nothing has ever run
// against real Postgres."
//
// Follows the house pattern (packages/db/tests/run-sql-suite.sh,
// packages/db/tests/run-l14-viewer-identity.sh): boot a disposable
// postgres:16-alpine container, apply packages/db/roles/*.sql then
// migrations 0001-0094 by exact numeric filename match (never a bare glob
// of the migrations directory — a concurrently-written 0095+ from another
// lane must not be swept in), then run the test.
//
// Unlike those two shell scripts, every statement here goes through
// `docker exec ... psql` from Go (os/exec) rather than shell, and the
// decisive step — proving the least-privilege role can actually do the
// job — connects as bsa_connector_poller, not as the postgres superuser
// used to apply migrations. bsa_connector_poller is defined NOLOGIN in
// every migration (correctly: production grants login separately, via
// deployment/IAM, per packages/db/roles/0001_v1_service_roles.sql's own
// comment); this test grants it a throwaway LOGIN + password itself,
// scoped to this disposable container only, exactly mirroring how
// deployment provisions login out-of-band in real environments.
//
// Run with: go test -tags=integration ./internal/store/... -run
// TestYoutubeDeliveryIntegration -v
// Requires: docker.
package store

import (
	"bytes"
	"context"
	"database/sql"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/bharatstudio/bharatstudio-alerts/services/youtube-poller-go/internal/domain"
)

const testPollerPassword = "youtube-poller-integration-test-only" // synthetic, disposable-container-only

func TestYoutubeDeliveryIntegration(t *testing.T) {
	if _, err := exec.LookPath("docker"); err != nil {
		t.Skip("docker not available; skipping integration test")
	}

	repoRoot := findRepoRoot(t)
	containerName := fmt.Sprintf("bsa-yt-poller-it-%d", time.Now().UnixNano())

	mustRun(t, "docker", "run", "-d", "--rm", "--name", containerName,
		"-e", "POSTGRES_PASSWORD=postgres",
		"-e", "POSTGRES_DB=postgres",
		"-p", "127.0.0.1:0:5432", // ephemeral host port; resolved below
		"postgres:16-alpine")
	t.Cleanup(func() {
		_, _ = runCommand("docker", "rm", "-f", containerName)
	})

	waitForPostgresReady(t, containerName)

	psql := func(sqlPath string) {
		t.Helper()
		data, err := os.ReadFile(sqlPath)
		if err != nil {
			t.Fatalf("read %s: %v", sqlPath, err)
		}
		out, err := runCommandStdin("docker", data, "exec", "-i", containerName,
			"psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres")
		if err != nil {
			t.Fatalf("apply %s: %v\n%s", sqlPath, err, out)
		}
	}

	for _, roleFile := range mustGlob(t, filepath.Join(repoRoot, "packages/db/roles/*.sql")) {
		psql(roleFile)
	}

	migrationsDir := filepath.Join(repoRoot, "packages/db/migrations")
	applied := 0
	for n := 1; n <= 94; n++ {
		padded := fmt.Sprintf("%04d", n)
		matches := mustGlob(t, filepath.Join(migrationsDir, padded+"_*.sql"))
		if len(matches) == 0 {
			continue
		}
		if len(matches) > 1 {
			t.Fatalf("more than one migration file matches prefix %s: %v", padded, matches)
		}
		psql(matches[0])
		applied++
	}
	if applied != 94 {
		t.Fatalf("applied %d migrations, want 94 (0001-0094 present)", applied)
	}
	t.Logf("applied %d migrations (0001-0094)", applied)

	// Disposable-container-only login grant. Production bsa_connector_poller
	// stays NOLOGIN — see packages/db/migrations/0091 and 0094; a real
	// environment provisions login via deployment/IAM (roles/0001's own
	// comment), never inside a migration. Synthetic password only.
	if _, err := runCommandStdin("docker", nil, "exec", "-i", containerName,
		"psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres", "-c",
		fmt.Sprintf(`alter role bsa_connector_poller login password '%s';`, testPollerPassword)); err != nil {
		t.Fatalf("grant test-only login to bsa_connector_poller: %v", err)
	}

	hostPort := resolvedHostPort(t, containerName)

	adminDB := openPostgres(t, fmt.Sprintf("postgres://postgres:postgres@127.0.0.1:%s/postgres?sslmode=disable", hostPort))
	defer adminDB.Close()
	pollerDB := openPostgres(t, fmt.Sprintf("postgres://bsa_connector_poller:%s@127.0.0.1:%s/postgres?sslmode=disable", testPollerPassword, hostPort))
	defer pollerDB.Close()

	seedChannelAndBinding(t, adminDB)

	// --- the actual proof: bsa_connector_poller runs the whole path itself ---
	store := NewEventStore(pollerDB)
	displayName := "Integration Viewer"
	event := domain.LiveEvent{
		SourceType:      "youtube",
		SourceID:        "it-msg-1",
		SourceEventType: domain.EventSuperChat,
		SourceUserID:    "UC_integration_viewer",
		Payload:         domain.LiveEventPayload{DisplayName: &displayName},
	}

	if err := store.InsertLiveEvent(context.Background(), integrationChannelID, 1, "it-trace-1", event); err != nil {
		t.Fatalf("InsertLiveEvent (first) as bsa_connector_poller: %v", err)
	}

	// Re-processing the identical message id must be a no-op: no second
	// alert, no second delivery.
	if err := store.InsertLiveEvent(context.Background(), integrationChannelID, 1, "it-trace-1-retry", event); err != ErrDuplicateEvent {
		t.Fatalf("InsertLiveEvent (retry) error = %v, want ErrDuplicateEvent", err)
	}

	// Verified as the admin connection: bsa_connector_poller itself holds
	// no direct SELECT on these tables (that is the point).
	assertOneRow(t, adminDB, `select count(*) from public.alert_events where channel_id = $1 and source_type = 'youtube' and source_id = 'it-msg-1'`, integrationChannelID)
	assertOneRow(t, adminDB, `select count(*) from public.event_outbox outbox join public.alert_events e on e.id = outbox.event_id where e.source_id = 'it-msg-1' and outbox.status = 'pending'`)
	assertOneRow(t, adminDB, `select count(*) from public.event_outbox_deliveries d join public.alert_events e on e.id = d.event_id where e.source_id = 'it-msg-1' and d.status = 'ready'`)

	var totalAlerts, totalOutbox, totalDeliveries int
	if err := adminDB.QueryRow(`select count(*) from public.alert_events where source_id = 'it-msg-1'`).Scan(&totalAlerts); err != nil {
		t.Fatal(err)
	}
	if err := adminDB.QueryRow(`select count(*) from public.event_outbox outbox join public.alert_events e on e.id = outbox.event_id where e.source_id = 'it-msg-1'`).Scan(&totalOutbox); err != nil {
		t.Fatal(err)
	}
	if err := adminDB.QueryRow(`select count(*) from public.event_outbox_deliveries d join public.alert_events e on e.id = d.event_id where e.source_id = 'it-msg-1'`).Scan(&totalDeliveries); err != nil {
		t.Fatal(err)
	}
	if totalAlerts != 1 {
		t.Fatalf("alert_events rows for it-msg-1 = %d, want exactly 1 (reprocessing must be a no-op)", totalAlerts)
	}
	if totalOutbox != 1 {
		t.Fatalf("event_outbox rows for it-msg-1 = %d, want exactly 1", totalOutbox)
	}
	if totalDeliveries != 1 {
		t.Fatalf("event_outbox_deliveries rows for it-msg-1 = %d, want exactly 1 (no second delivery on reprocess)", totalDeliveries)
	}

	t.Log("PASS: end-to-end YouTube delivery, run as bsa_connector_poller, idempotent on reprocess")
}

const integrationChannelID = "00000000-0000-4000-8000-0000000017f1"

func seedChannelAndBinding(t *testing.T, db *sql.DB) {
	t.Helper()
	stmts := []string{
		`insert into app_users (id, external_subject, display_name, created_at, updated_at)
		 values ('00000000-0000-4000-8000-0000000017f0', 'google-it-owner', 'Integration Owner', current_timestamp, current_timestamp)
		 on conflict (id) do nothing`,
		`insert into channels (id, owner_user_id, handle, display_name, accepting_tips, public_config_version, created_at, updated_at)
		 values ('` + integrationChannelID + `', '00000000-0000-4000-8000-0000000017f0', 'it_channel', 'Integration Channel', true, 1, current_timestamp, current_timestamp)
		 on conflict (id) do nothing`,
		`insert into channel_configs (channel_id, version, values, effective_at, created_at)
		 values ('` + integrationChannelID + `', 1, '{}'::jsonb, current_timestamp, current_timestamp)
		 on conflict (channel_id, version) do nothing`,
		`insert into alert_queues (id, channel_id, name, created_at, updated_at)
		 values ('00000000-0000-4000-8000-0000000017f2', '` + integrationChannelID + `', 'Integration Queue', current_timestamp, current_timestamp)
		 on conflict (id) do nothing`,
		`insert into queue_bindings (id, channel_id, queue_id, source_type, source_id, allow_duplicates, priority, created_at)
		 values ('00000000-0000-4000-8000-0000000017f3', '` + integrationChannelID + `', '00000000-0000-4000-8000-0000000017f2', 'youtube', '__channel_default__', true, 10, current_timestamp)
		 on conflict (queue_id, source_type, source_id) do nothing`,
	}
	for _, stmt := range stmts {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("seed fixture: %v\n%s", err, stmt)
		}
	}
}

func assertOneRow(t *testing.T, db *sql.DB, query string, args ...any) {
	t.Helper()
	var count int
	if err := db.QueryRow(query, args...).Scan(&count); err != nil {
		t.Fatalf("query %q: %v", query, err)
	}
	if count != 1 {
		t.Fatalf("query %q returned count=%d, want 1", query, count)
	}
}

func openPostgres(t *testing.T, dsn string) *sql.DB {
	t.Helper()
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatalf("open %s: %v", dsn, err)
	}
	deadline := time.Now().Add(30 * time.Second)
	var pingErr error
	for time.Now().Before(deadline) {
		if pingErr = db.Ping(); pingErr == nil {
			return db
		}
		time.Sleep(300 * time.Millisecond)
	}
	t.Fatalf("ping %s: %v", dsn, pingErr)
	return nil
}

func waitForPostgresReady(t *testing.T, containerName string) {
	t.Helper()
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := runCommand("docker", "exec", containerName, "pg_isready", "-U", "postgres", "-d", "postgres"); err == nil {
			return
		}
		time.Sleep(1 * time.Second)
	}
	t.Fatal("postgres did not become ready in time")
}

var hostPortPattern = regexp.MustCompile(`0\.0\.0\.0:(\d+)|127\.0\.0\.1:(\d+)`)

func resolvedHostPort(t *testing.T, containerName string) string {
	t.Helper()
	out, err := runCommand("docker", "port", containerName, "5432/tcp")
	if err != nil {
		t.Fatalf("docker port: %v\n%s", err, out)
	}
	matches := hostPortPattern.FindStringSubmatch(out)
	if matches == nil {
		t.Fatalf("could not parse host port from %q", out)
	}
	for _, group := range matches[1:] {
		if group != "" {
			return group
		}
	}
	t.Fatalf("no host port captured from %q", out)
	return ""
}

func findRepoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if _, statErr := os.Stat(filepath.Join(dir, "packages/db/migrations")); statErr == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("could not locate repo root (no packages/db/migrations found above test cwd)")
		}
		dir = parent
	}
}

func mustGlob(t *testing.T, pattern string) []string {
	t.Helper()
	matches, err := filepath.Glob(pattern)
	if err != nil {
		t.Fatalf("glob %s: %v", pattern, err)
	}
	sort.Strings(matches)
	return matches
}

func mustRun(t *testing.T, name string, args ...string) {
	t.Helper()
	if out, err := runCommand(name, args...); err != nil {
		t.Fatalf("%s %v: %v\n%s", name, args, err, out)
	}
}

func runCommand(name string, args ...string) (string, error) {
	return runCommandStdin(name, nil, args...)
}

func runCommandStdin(name string, stdin []byte, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	err := cmd.Run()
	return out.String(), err
}

