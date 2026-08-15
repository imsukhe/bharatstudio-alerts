# BharatStudio Alerts v1 — Observability Trace Contract

**Status:** Local contract implemented and tested; deployed correlation and log/alert proof remain L09 staging gates.

## Purpose

The trace ID is a bounded diagnostic correlation value. It is not an
authorization credential, payment identifier substitute, request payload, or
Prometheus label. Financial and delivery correctness remains in the durable
database keys and state transitions.

## Canonical value

For a verified Razorpay webhook, the server derives:

```text
razorpay:<x-razorpay-event-id>
```

The value is never accepted from a client trace header as the source of truth.
The provider event ID is validated and deduplicated before this value is
written to the alert event.

## Required propagation

```text
verified webhook
  → alert_events.trace_id
  → event_outbox_deliveries / ready-delivery listing
  → Cloud Tasks command.traceId
  → worker delivery/publish evidence
  → overlay replay traceId
```

The same event may have multiple queue deliveries, but all deliveries retain
the same event trace ID. Queue-specific state is carried by the delivery and
outbox IDs; it must not be encoded into the trace ID.

## Boundary rules

- Allowed characters: ASCII letters, digits, `-`, `_`, `.`, `:`.
- Maximum length at service boundaries: 128 characters.
- Whitespace and control characters are rejected.
- Logs may include the trace ID only in authenticated internal structured
  records; public responses may include the API request trace ID needed for
  support, but must not include payment payloads or secrets.
- Prometheus labels must not contain trace IDs, event IDs, order IDs, payment
  IDs, account references, donor identity, queue IDs, or user IDs.
- If correlation metadata is malformed or unavailable, the durable operation
  fails/retries according to the owning boundary; it is never replaced with
  `Date.now()`, a random per-retry value, or a client-supplied value.

## Local evidence

- Payment ingress derives and forwards the trace on the private worker-pump
  hop: `services/payment-webhook-go/internal/ingress/trace.go` and
  `worker_pump.go`.
- Worker task validation bounds and character-checks `Command.TraceID`, and
  JSON round-trip tests preserve it.
- The disposable PostgreSQL L03 harness verifies the derived value survives
  payment persistence, independent queue delivery projection, and
  `app_private.get_overlay_events` replay.
- Metrics tests verify that identifiers are absent from Prometheus output.

## Not claimed by this contract

This local contract does not prove deployed Cloud Run request logging,
cross-service log collection, dashboard retention, alert routing, staging
capacity, cross-replica listener behavior, or provider sandbox/live behavior.
Those remain L09-03/L09-04 acceptance work.
