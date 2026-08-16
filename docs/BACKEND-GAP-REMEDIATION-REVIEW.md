# Backend gap remediation review record

**Status:** `Open — self-review in progress`
**Reviewer:** Codex self-review
**Scope:** v1 backend/runtime gaps from the backend audit and follow-up omissions

## Initial dispositions

| Finding | Disposition |
|---|---|
| Creator payment onboarding absent | Confirmed launch blocker; implement boundary and retain provider gate |
| TTS completely absent | Corrected: playback/fallback exists; synthesis boundary missing |
| Queue modes completely absent | Corrected: client presentation exists; server enforcement incomplete |
| Replay publisher is a broken no-op | Rejected: intentional durable publication design; requires staging proof |
| Reconciliation manual-review repeat | Confirmed; payment and refund paths both require quarantine |
| CAPTCHA/abuse controls absent | Confirmed conditional P1 before public payment launch |
| Entitlements only queueCount enforced | Corrected: numeric controls are partial; feature controls incomplete |
| Workspace missing | Intentional v1 boundary; Enterprise Phase 2 |
| Account lifecycle/legal acceptance absent | Confirmed launch blocker for full-product promise |
| Cloud Tasks/deployment evidence absent | Confirmed launch blocker until staging evidence |

This record must be updated after each work package with evidence, severity,
disposition, owner and follow-up. It must not be treated as independent review.

## Pass 2 implementation review — 2026-08-16

| Area | Implementation evidence | Verification | Status |
|---|---|---|---|
| Reconciliation poison-pill | Migration 0059 and Go quarantine stores/runners | L04 quarantine SQL plus Go unit/integration tests | Implemented; locally verified |
| Creator payment account | Migration 0060, authenticated routes, provider-only activation audit | API tests plus register/activate/switch/revoke lifecycle fixture in isolated migration suite | Implemented; provider approval/sandbox external |
| Account lifecycle/consent | Migration 0061, Terms/export/privacy/soft-close routes | API tests and isolated migration suite | Implemented; legal review external |
| Quiet/approval/moderation | Migration 0062 and L05 policy test | `L05_QUEUE_POLICY=PASS` with durable no-drop assertions | Implemented; locally verified |
| Publication/source-rate/replay | Migrations 0063–0064 | L03, overlay cross-replica and replay tests | Implemented; locally verified |
| Server queue selection | Migration 0065 priority ageing plus client presentation modes | Full isolated DB suite | Implemented; capacity/load proof required |
| Public abuse | Turnstile adapter, production fail-closed config, tip route limit 20/min | API Turnstile pass/fail test | Implemented; provider/WAF staging external |
| OIDC audience mismatch | Payment/worker boot checks and deployment env contract | Go unit tests; manifest validation | Implemented; deployed IAM proof external |
| TTS synthesis boundary | Sarvam adapter, 13 locales, 1.5s timeout/cache key/chime fallback | API provider/fallback/cache tests | Implemented boundary; credentials/artifact hosting external |
| Deployment transport | Cloud Run and Cloud Tasks/DLQ templates plus validator | `BSA_DEPLOYMENT_MANIFESTS=PASS` | Defined; not deployed |

The pass uncovered real regressions in the first queue-policy draft: publication
markers, source-rate limiting and older unacknowledged replay had been omitted
when durable functions were redefined. Migrations 0063–0065 restored those
invariants and the full isolated suite was rerun successfully.

## Pass 3 — 2026-08-16 deep follow-up

| Area | Finding | Remediation/evidence | Status |
|---|---|---|---|
| Terms/privacy enforcement | Acceptance and privacy routes existed, but product mutations could proceed without accepted active documents; no active-document seed must not mean implicit consent | `requireAuthAndTerms`, mutation-route wiring, production/staging boot guard, migration 0066 fail-closed function, `apps/api/test/terms-gate.test.ts` | Locally verified |
| Entitlement boundary | Feature matrix values are product-owned and must not be invented in code | Server rejects only explicitly published `configFeatures`; queue count/action limits remain enforced; missing matrix remains backward-compatible | Conditional until final matrix is published |
| Payment ingress identity | A rewrite must not derive deduplication from time or browser input | Go verifier requires `X-Razorpay-Event-Id`; DB uniqueness includes provider/environment/account/event | Locally verified |
| Provider/WAF controls | Turnstile and API rate limiting do not by themselves provide a distributed edge budget | Deployment contract records mandatory production WAF/edge rate limit; API limit remains defense-in-depth | External staging/provisioning gate |
| Payment/refund scope | New v1 has reconciliation/status evidence, not an invented user refund API | Provider refund state is webhook/reconciliation-owned; no public refund route is exposed without approved authorization/retention policy | Deliberately bounded; legal/provider decision required for any expansion |
