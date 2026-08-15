# BharatStudio alert worker routing

This package contains the deterministic L31/L32 routing and durable task-boundary slices for the Go alert worker.

`routing.Resolve` correlates the event source before applying priority and preserves each matching queue's source-specific overrides. It returns one independent delivery plan per permitted queue. `tasks.Command` validates the durable action envelope and produces a stable retry idempotency key. `store.DeliveryStore` calls only the worker-owned database functions for claim/retry/complete; it does not write delivery tables directly. `store.WakeupNotifier` is best-effort and runs only after durable completion. Cloud Tasks execution, capacity handling, overlay publication and crash recovery are still separate work.

`auth.OIDCAuthorizer` requires a configured audience and delegates token signature/issuer verification to the platform verifier. `auth.GoogleTokenVerifier` uses Google's maintained `idtoken.Validator`; missing configuration fails closed. The Cloud Run service account and audience remain deployment configuration, never request input.

`tasks.Enqueuer` builds one `deliver_overlay` Cloud Tasks request with a stable SHA-256 task name derived from delivery/version/attempt, a bounded JSON body and explicit OIDC target metadata. The OIDC audience is the separately configured `ALERT_WORKER_PRIVATE_AUDIENCE` shared by the worker verifier; it is never inferred from the target URL. A provider `AlreadyExists` result is treated as idempotent success; all other provider failures remain retryable to the caller. The concrete Google client, Cloud Run IAM binding and dead-letter queue still require deployment/staging evidence.

The private `/internal/v1/tasks/pump` handler scans ready delivery rows and invokes the enqueuer through a bounded worker pool (default concurrency 8, configured with `ALERT_WORKER_PUMP_CONCURRENCY`). It is called by the payment boundary after durable webhook persistence and can also be used by recovery operations. It never acknowledges or deletes a ready row; a partial Cloud Tasks failure returns retryable status and the stable task identity makes the next scan safe. The setting improves provider round-trip throughput without changing per-delivery durable ordering or idempotency.

`db.Open` provides the worker's fail-fast pgx/database/sql bootstrap with explicit pool bounds. The worker must use its private service identity and migration-approved database endpoint; no DSN is accepted from a task request.

Run the tests with:

```sh
go test ./...
```
