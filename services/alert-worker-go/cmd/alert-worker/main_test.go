package main

import "testing"

func TestWorkerAudienceMustMatchAtBoot(t *testing.T) {
	if err := validateWorkerAudience("audience-a", "audience-b"); err == nil {
		t.Fatal("mismatched worker audience should fail closed")
	}
	if err := validateWorkerAudience("audience-a", "audience-a"); err != nil {
		t.Fatalf("matching worker audience rejected: %v", err)
	}
}
