# BharatStudio Alerts deployment contract

This directory is the deployment contract for the v1 services. It is not an
automatic production deployment and contains no secrets. Replace image and
project placeholders in a controlled release pipeline only after the gates in
`bharatstudio-requirements/active/launch/01_MASTER_RELEASE_AUTHORITY.md` are
verified.

## Runtime split

| Service | Owns | Database role | Minimum availability rule |
|---|---|---|---|
| `bharatstudio-alerts-api` | web API, public tip page API, dashboard, durable SSE replay | `bsa_app` | at least one instance while overlays are enabled |
| `bharatstudio-payment-webhook` | Razorpay provider webhook ingress, checkout boundary, reconciliation | `bsa_payment` | provider webhook path is public-facing; browser cannot call private payment routes; internal calls require OIDC |
| `bharatstudio-alert-worker` | durable delivery claim, Cloud Tasks handler, pump | `bsa_alert_worker` | private ingress only; one or more instances |

The API and worker use the pooled application endpoint for ordinary queries.
The API overlay listener uses `DATABASE_URL_DIRECT` only; it must be a direct,
non-pooled Neon endpoint. A pooled endpoint must never be used for `LISTEN`.
Payment and worker services have separate bounded pools and do not share a
module-level client.

## Required identity contract

`ALERT_WORKER_PUMP_AUDIENCE` and `ALERT_WORKER_PRIVATE_AUDIENCE` must be the
same exact value in the payment and worker services. Both binaries fail at boot
on a mismatch. The payment service account may invoke only the worker pump
route; Cloud Tasks may invoke only the worker task route. No public route may
reach payment reconciliation, archival or worker task handlers.

## Required secret/config contract

Provision through Secret Manager or the platform's secret binding; never put
values in these manifests or commit them:

- `DATABASE_URL_APP`, `DATABASE_URL_DIRECT` (API); `PAYMENT_DATABASE_URL`
  (payment); `ALERT_WORKER_DATABASE_URL` (worker);
- Razorpay live/test key ID, key secret, webhook secret and connected-account
  approval configuration;
- Google/OIDC client and service-audience configuration;
- `PUBLIC_PAYMENT_TURNSTILE_SECRET` and explicit
  `PUBLIC_PAYMENT_TURNSTILE_REQUIRED=true` in production;
- notification token encryption key and provider credentials where enabled.

The API production readiness check rejects missing direct/pool separation and
missing Turnstile configuration; production configuration cannot disable the
Turnstile boundary. The payment and worker binaries reject
missing OIDC/audience settings and audience mismatch.

The Fastify rate limiter is intentionally only an instance-local defense. The
public payment hostname must sit behind a distributed edge/WAF policy with a
bounded per-client request budget and a separate webhook allowlist/secret
verification path. Cloud Run autoscaling is not the abuse-control boundary.

## Cloud Run starting guardrails

The checked-in manifests start with conservative caps, not a claimed capacity
limit: API max 10 / concurrency 80, payment max 10 / concurrency 40, worker
max 4 / concurrency 20. These are staging values to be load-tested and
re-derived from the selected Neon plan. They may be raised only with receipt
latency, SSE fan-out, database pool, Cloud Tasks retry and no-drop evidence.

## Cloud Tasks rules

- A task is a wake-up/attempt, not the financial source of truth.
- Handler retry is safe because delivery claim uses delivery ID, state version,
  lease token and publication marker.
- Accepted but blocked/failed rows remain durable and are replayable.
- Queue retry and dead-letter policies are in `cloud-tasks/queues.yaml`; an
  operator must inspect and replay a DLQ item through the database state
  machine, never by inserting a second payment or alert.
- Scheduler/Cloud Tasks resources remain disabled until service accounts,
  private ingress, monitoring, retry and staging rehearsal evidence exist.
