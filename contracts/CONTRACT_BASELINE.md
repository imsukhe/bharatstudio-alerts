# BharatStudio Alerts v1 contract and database baseline

**Status:** `Implemented — verification pending`  
**Owner:** Alerts architecture / API / database  
**Authority:** `bharatstudio-requirements/active/launch/00_LAUNCH_SCOPE_AUTHORITY.md`  
**Task:** `bharatstudio-requirements/tasks/L01-contracts-and-database-baseline.md`  
**Scope:** v1 Alerts and Companion; YouTube and Enterprise excluded

This is the language-neutral baseline for TypeScript, Go, React Native, C#, and Swift. It is not yet an approved production API or database migration.

## Contract rules

- Public and client-facing APIs use versioned HTTPS REST/JSON with OpenAPI.
- Server-to-overlay delivery uses HTTPS SSE. Durable outbox state and cursor/replay are authoritative; live notification is only a wake-up optimisation.
- Payment, alert, queue, audit and reconciliation evidence is append-only or corrected through linked compensating records.
- Every external/provider event has a stable provider delivery identity. For Razorpay webhooks, the verified `x-razorpay-event-id` is the delivery deduplication key; payment/refund/dispute IDs remain separate business keys.
- Every event and command includes a schema version, event ID, trace ID and created timestamp.
- Additive fields are backward-compatible. Breaking changes require a new API/event version and a migration/deprecation note.
- Unknown enum values must be handled safely by clients; producers may add values only through a reviewed contract change.
- No contract contains YouTube scopes/events or Enterprise roles, allocations, settlement or funds movement.

## v1 REST surface inventory

The first OpenAPI draft must cover these groups. Exact paths and field schemas are to be reviewed before implementation:

| Group | Purpose | Authentication |
|---|---|---|
| Public channel/tip page | Resolve public creator/channel presentation and create a Razorpay order request | Public read; rate-limited order creation |
| Creator session/account | Current user, channels, roles, plan/entitlements and device sessions | Google-authenticated user |
| Alert configuration | Alert templates, branding, queues, bindings, preview/test alert and moderation controls | Channel-scoped role |
| Overlay session | Issue/rotate scoped overlay token and expose SSE stream with cursor replay | Short-lived overlay credential |
| Payment state | Customer-visible order/receipt/refund status and creator payment setup state | Authenticated creator; no client-side financial authority |
| Companion control | Pairing, session lease, approved actions, health and acknowledgement | Authenticated user/device; server-authorised |
| Internal jobs | Reconciliation, expiry, archive and recovery handlers | Private OIDC service identity only |

The L03 contract pass expands `contracts/openapi/v1.yaml` with the concrete
v1 route surface for current-user sessions, channel setup, versioned alert
configuration, queues and bindings, test alerts, history/moderation, billing
view, overlay rotation/revocation and the Web Companion Console. The draft
also includes synthetic request/response examples under
`contracts/fixtures/api/`. These additions remain contract-review material;
they do not authorize domain implementation until L01 verification and the
relevant L03/L04/L05 acceptance cases are approved.

The public API must never expose secrets, provider credentials, raw webhook bodies, private audit details, internal topology or unrestricted database identifiers.

## Event and command envelopes

All JSON event/command schemas must include:

```text
schemaVersion: string
eventId: string
eventType: string
traceId: string
createdAt: RFC3339 timestamp
producer: string
payload: object
```

### Payment webhook delivery

The payment service receives the raw body and signature headers, verifies HMAC before business processing, then records:

```text
provider: "razorpay"
environment: "test" | "live"
connectedAccountRef: opaque internal/provider reference
providerEventId: verified x-razorpay-event-id
entityType: payment | refund | subscription | dispute
entityId: provider business-entity ID
rawBodyHash: digest, not raw body in normal logs
signatureVerifiedAt: timestamp
receivedAt: timestamp
```

`provider + environment + connectedAccountRef + providerEventId` is unique. Missing provider event identity follows the explicit retry/quarantine policy; it must never receive a timestamp/random substitute.

### Alert event

An accepted alert contains its immutable payment/evidence reference, creator/channel, source identity, frozen configuration/entitlement snapshot, display policy and queue-routing intent. It does not contain current-tier lookups that could change historical behaviour.

### Per-queue delivery

Multi-queue routing creates independent durable delivery state for every permitted queue:

```text
eventId
queueId
deliveryId
sourceId
bindingId
configSnapshotVersion
deliverySequence
status
attemptCount
nextActionAt
lastErrorCode
```

No global event status may prevent an independently permitted queue from progressing. Source identity is resolved before source/priority correlation and per-source style, bracket or rate-limit overrides.

### Cloud Tasks command

Each task carries the durable next action, event/outbox/delivery identity, expected state/version, attempt number, trace ID, deadline and dead-letter policy. Duplicate or concurrent task execution must be harmless.

### Overlay SSE event

The SSE event ID is a replayable server cursor, not a payment/provider ID. The stream must support initial cursor, reconnect with `Last-Event-ID`, resync boundary, ordered eligible delivery, acknowledgement/receipt state and an explicit resync-required response when the cursor is outside the retained replay window.

## Logical v1 database ownership

The clean baseline must model, at minimum:

| Logical area | Ownership rule |
|---|---|
| Identity, users, channels, roles | Request API; channel-scoped authorization and RLS |
| Plans, entitlements, entitlement versions | Server-owned; versioned changes; cache invalidation cannot be correctness-critical |
| Payment webhook deliveries | Payment service; append-only; unique provider delivery identity |
| Payments, refunds, disputes, subscriptions | Payment service; immutable facts plus linked compensating state |
| Alert ledger and frozen snapshots | Payment/Alerts boundary; accepted evidence is append-only |
| Event outbox and per-queue delivery | Alert worker; one durable delivery state per permitted queue |
| Overlay cursors and acknowledgements | Overlay/Alerts service; replay-safe and scoped to overlay credential |
| Processing attempts, audit, reconciliation work | Service-owned append-only evidence with controlled archival |

RLS context, service bypass scope, `SECURITY DEFINER` privileges, and archive transfer rules require a separate security review. Scheduler and clients receive no database credentials.

## Migration baseline

- Create a new reviewed v1 baseline migration for clean isolated environments.
- Preserve legacy migrations as evidence only; do not execute the historical chain as the new production baseline.
- Define a separate synthetic-data upgrade path only if staging evidence requires it.
- Do not provision or alter a shared/production database during contract definition.

## Artifacts produced in this definition pass

1. `contracts/openapi/v1.yaml` — draft REST surface.
2. `contracts/json-schema/*.schema.json` — payment delivery, alert event, queue delivery, overlay SSE event, entitlement result and error envelope.
3. `contracts/fixtures/*.json` and `contracts/enums/v1.json` — sanitized golden fixtures and enums, including the D-2 multi-queue scenario and overlay reconnect scenario.
4. `packages/db/migrations/0001_v1_baseline.sql` — clean logical schema draft; role/RLS migration remains L02.

These artifacts remain unapproved for production until the acceptance record, security review and independent review pass.

## Open decisions before implementation

- Exact public path/field names and error codes.
- Neon production plan/region and direct-listener connection budget.
- Final RLS bypass union and `SECURITY DEFINER` grants.
- Retention windows for replay cursors and operational event evidence.

These are implementation-gate decisions, not permission to expand v1 into YouTube or Enterprise.
