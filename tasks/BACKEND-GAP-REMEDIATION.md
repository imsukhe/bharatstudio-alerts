# Backend gap remediation task

**Status:** `In progress`
**Authority:** `bharatstudio-requirements/active/launch/06_BACKEND_GAP_REMEDIATION_AUTHORITY.md`
**Owner:** Project owner

## Work packages

- [x] R1 Creator payment-account onboarding, activation, switching, audit and
  settlement boundary.
- [x] R2 Payment/refund reconciliation manual-review quarantine and operator
  recovery path.
- [x] R3 Queue policy enforcement: quiet mode, approval, rate limits, queue
  modes, duplicate routing and durable no-drop behavior.
- [x] R4 Entitlement enforcement foundation for server-owned v1 limits and feature gates; final published matrix remains a product/configuration gate.
- [x] R5 Account lifecycle, privacy request intake, Terms acceptance, retention
  and access/deactivation controls.
- [x] R6 Public-payment abuse controls and provider/CSP/CORS contract checks.
- [x] R7 Cloud Tasks, IAM/OIDC, DLQ, secrets, migration and SSE/replay deployment
  contracts.
- [x] R8 TTS provider boundary, alert-worker caller, durable scoped audio
  artifact, safe audio policy and explicit unavailable state.
- [ ] R9 Cross-repository contract, failure, load and end-to-end evidence.
- [ ] R10 Independent review, remediation audit and release-authority update.

## Completed implementation slices

- [x] R1 payment-account onboarding boundary: migration 0060, API routes and
  provider-only activation audit.
- [x] R2 reconciliation quarantine: migration 0059, Go stores/runners and
  SQL/integration evidence.
- [x] R3 queue policy: migrations 0062–0065, moderation/quiet/approval/no-drop,
  source-rate/publication preservation, replay safety and priority ageing.
- [x] R5 account lifecycle/consent: migration 0061, Terms, export, privacy
  request and soft-close routes.
- [x] R6 public abuse: production-required Turnstile and route-specific limit.
- [x] R7 OIDC/deployment contract: boot audience checks and Cloud Run/Tasks
  templates with secret substitution markers.
- [x] R8 TTS integration: bounded Sarvam adapter, alert-worker OIDC caller,
  durable artifact/overlay-audio route, 1.5s timeout, cache key and chime
  fallback.
- [x] R9a Terms/privacy mutation gate: product writes require current accepted
  documents; account acceptance/export/privacy/closure remain available.
- [x] R9b Public-payment defense-in-depth: Turnstile plus instance-local API
  limit, with distributed edge/WAF limiting recorded as a deployment gate.

R4's server-enforcement foundation is implemented: current queue-count and
Companion action/page limits are enforced, and explicitly published
`configFeatures` reject disallowed queue modes, display/message/TTS/quiet/
approval settings. A final product-owned feature matrix is still required
before new restrictions are introduced. R9–R10 remain release-evidence work:
provider
sandbox/live, IAM/secret provisioning, deployed capacity/failure tests,
independent review and final authority disposition. Email/referral are not v1
promises and remain deferred by authority; YouTube/Enterprise remain Phase 2.

## Implementation rules

1. Add characterization tests before changing behavior.
2. Use append-only/compensating records for payment and delivery evidence.
3. Never rewrite or squash existing migrations. Add forward-only migrations.
4. Never commit secrets or real payment/personal data.
5. A test that cannot run without a provider, deployment or credential is marked
   blocked with the exact external prerequisite; it is not marked passed.

## Acceptance

Each work package must include implementation, focused tests, failure/recovery
tests, evidence, self-review, and a recorded independent review or conditional
status. The task cannot be marked complete while a required provider/deployment/
legal gate is only described.
