# Backend gap remediation acceptance record

**Status:** `In progress`
**Authority:** `06_BACKEND_GAP_REMEDIATION_AUTHORITY.md`

## Required evidence matrix

| ID | Acceptance evidence | Status |
|---|---|---|
| R1 | Onboarding/account-bound order/refund tests; unauthorized account-switch test; provider sandbox evidence | Local onboarding/account-attribution tests pass; provider sandbox/account activation is external and remains blocked |
| R2 | Payment and refund unknown-state quarantine, retry, operator replay and idempotency tests | Local SQL quarantine plus Go payment/refund tests pass on 2026-08-16 |
| R3 | Quiet/approval/rate-limit/duplicate-routing/no-drop concurrency and replay tests | Local L03/L05 SQL, cross-replica SSE and Go routing/handler tests pass; staging capacity/Cloud Tasks proof remains open |
| R4 | Server-owned entitlement rejection/allowance tests for every v1 feature | Foundation verified: queue/action/page limits plus explicit `configFeatures` policy tests pass; final product matrix is still required |
| R5 | Deactivation/export/privacy/Terms/retention authorization and audit tests | Local account lifecycle SQL/API tests, fail-closed no-document migration and mutation terms-gate tests pass on 2026-08-16 |
| R6 | Public abuse/rate-limit/CSP/CORS/provider-header tests | API Turnstile pass/fail, route limit, CORS/security-header and Go Razorpay header tests pass; distributed edge/WAF staging proof remains open |
| R7 | OIDC audience/IAM/DLQ/migration/SSE-reconnect deployment rehearsal | Boot checks, manifest validator, isolated migrations and SSE cross-replica tests pass; IAM/Cloud Tasks/DLQ rehearsal is blocked until staging |
| R8 | TTS timeout/fallback/provider-unavailable, internal caller, durable artifact and safe-origin tests | API 79-test suite, Go TTS caller tests, isolated DB TTS artifact test and authenticated overlay-audio route pass; credentials/provider/production artifact-capacity staging remains external |
| R9 | Cross-service contract, failure, load, restore and browser/OBS evidence | Contracts, Go/TS unit/integration and disposable DB evidence pass; deployed load/restore/browser/OBS evidence remains open |
| R10 | Fresh independent review with disposition for every finding | Self-review updated through Pass 3; independent review is still required |

Local tests are evidence of code behavior only; they do not close provider,
deployment, legal, store or production-capacity gates.

## Executed local evidence — 2026-08-16

- `apps/api`: 76/76 tests passed; TypeScript build passed, including the
  channel-store entitlement boundary regression.
- After TTS caller integration: `apps/api` 79/79 tests passed; Go alert-worker
  race/vet suite and TTS caller tests passed.
- Payment and alert-worker Go test suites, `go vet`, and race checks passed in
  the corresponding service packages.
- `sh packages/db/tests/run-l03-application-behavior.sh` passed the isolated
  PostgreSQL migration/application suite, including L03, L05 and L04 slices,
  payment-account onboarding lifecycle, cross-replica overlay wake-up/replay
  and worker-store integration.
- `npm run contracts:validate` and `deployment/validate-manifests.sh` passed.
