package tasks

import "testing"

func TestBuildCreateTaskRequestKeepsTargetAndAudienceIndependent(t *testing.T) {
	request, err := buildCreateTaskRequest(Task{
		Queue:              "projects/p/locations/l/queues/q",
		Name:               "projects/p/locations/l/queues/q/tasks/bsa-1",
		TargetURL:          "https://worker.example/internal/v1/tasks/overlay",
		OIDCAudience:       "https://worker.example",
		OIDCServiceAccount: "worker@example.iam.gserviceaccount.com",
		Body:               []byte(`{"action":"deliver_overlay"}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	httpRequest := request.GetTask().GetHttpRequest()
	if httpRequest.GetUrl() != "https://worker.example/internal/v1/tasks/overlay" {
		t.Fatalf("target URL = %q", httpRequest.GetUrl())
	}
	if httpRequest.GetOidcToken().GetAudience() != "https://worker.example" {
		t.Fatalf("OIDC audience = %q", httpRequest.GetOidcToken().GetAudience())
	}
	if httpRequest.GetOidcToken().GetAudience() == httpRequest.GetUrl() {
		t.Fatal("test must prove the audience is not derived from the target URL")
	}
}

func TestBuildCreateTaskRequestRequiresOIDCAudience(t *testing.T) {
	_, err := buildCreateTaskRequest(Task{
		Queue:              "queue",
		Name:               "task",
		TargetURL:          "https://worker.example/task",
		OIDCServiceAccount: "worker@example.com",
		Body:               []byte(`{}`),
	})
	if err != ErrInvalidEnqueuer {
		t.Fatalf("error = %v, want ErrInvalidEnqueuer", err)
	}
}
