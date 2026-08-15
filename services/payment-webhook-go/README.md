# BharatStudio Razorpay webhook boundary

This package contains the currently verified L04 boundary slices: raw-body HMAC-SHA256 verification, mandatory Razorpay delivery-identity extraction, and a server-only Orders API adapter.

The verifier deliberately does not parse, acknowledge, or mutate payment state. The Orders adapter also does not persist state: the caller must create and persist its local payment intent/idempotency record before calling Razorpay, then persist the provider order response atomically with the local state transition. The production handler must resolve the connected-account/environment context and persist the verified delivery plus its financial effect atomically before returning success. Duplicate delivery handling belongs to the database uniqueness constraint on:

```text
provider + environment + connected_account_ref + provider_event_id
```

Run the pure verifier tests with:

```sh
go test ./...
```

The Orders adapter enforces BharatStudio's ₹10 platform floor (1,000 paise), INR-only launch scope, receipt and notes bounds, HTTPS provider configuration, bounded responses, response-to-request amount/currency/receipt matching, explicit linked-account routing and retry classification for transport, timeout, rate-limit and 5xx failures. It exposes no provider error body to callers. The account-scoped fetch methods are available for a later reconciliation/status worker; they are not a replacement for webhook evidence.

`webhook.ParseEvent` normalizes only the signed payload fields needed by the state machine for payment/order, refund, subscription and dispute events. It tolerates additional provider fields, rejects malformed/trailing JSON and unsupported event families, and never replaces the raw signed body as immutable evidence.

`ingress.SQLStore` is the production-shaped adapter for the private `bsa_payment` database function: it resolves the local order intent and active payment bindings, derives linked-account attribution from the verified signed payload, generates UUIDs locally, and sends one normalized projection plus queue rows to the atomic persistence function. It does not trust account, channel, amount or order identity from an unsigned client; missing webhook account attribution fails closed. `db.Open` provides fail-fast pgx/database/sql bootstrap and bounded pool configuration. `cmd/payment-webhook` mounts the webhook and private checkout handlers, validates Google OIDC for the private route, applies HTTP timeouts and does not run migrations automatically. Deployment, IAM, secret provisioning and provider test-mode execution remain deployment work.

After verified persistence, the webhook handler invokes the private alert-worker pump. A pump failure returns a retryable response so the provider can redeliver; duplicate delivery persistence remains safe and the worker's stable task names make repeated scans idempotent. Production requires `ALERT_WORKER_PUMP_URL` and `ALERT_WORKER_PUMP_AUDIENCE`; the pump audience must equal the worker's canonical `ALERT_WORKER_PRIVATE_AUDIENCE` verifier value, with service-account invocation IAM. This equality remains a deployment configuration/negative-test gate.

The worker-pump hop has an independent 5-second client deadline. A stalled or unavailable worker therefore returns a retryable webhook failure instead of holding the receipt path until the outer HTTP timeout; the verified event is already durable and remains eligible for provider redelivery/recovery. This timeout bounds the network hop only and does not acknowledge or delete a persisted delivery.

The private `POST /internal/v1/reconciliation/payments` route owns bounded provider-order reconciliation. It uses the same OIDC boundary as the checkout route, fetches candidates through the Razorpay adapter, expires only verified unpaid intents, and queues a payment-recovery work item for a verified paid order. It then fetches the documented order-payment collection, selects only a captured payment whose order/amount/currency match the immutable intent, persists through the same atomic payment/outbox boundary as a webhook, and closes the recovery item only after that evidence exists. It never marks a payment paid from order status alone. Partial/provider failures return retryable `503`; the Cloud Scheduler template targets this route directly and remains disabled until IAM and staging evidence exist.

The private `POST /internal/v1/reconciliation/refunds` route lists only local requested refunds, fetches each refund by provider ID, validates the linked payment/amount/currency, and applies only documented processed/failed/reversed state transitions. It never creates a refund and never changes historical tip or alert payloads. Pending/provider failures remain retryable or no-op.

The private `POST /internal/v1/subscriptions` route now owns the paid-plan
creation boundary. The Creator API may send only the authenticated user/channel,
public tier, monthly/annual interval and matching idempotency key. The payment
service resolves the environment-specific Razorpay platform account and plan
IDs from its catalog; prices are code-owned (`Pro ₹199`, `Creator ₹399`,
`Studio ₹499` monthly, with annual billing charged for 10 months and service
provided for 12). A `subscription_creation_intents` row is written before
provider I/O, provider identity is attached only after response validation, and
the canonical account-scoped link is required before billing webhooks can grant
access. Ambiguous provider results and link failures enter recovery rather than
blindly creating another subscription. Missing catalog identifiers fail closed
with an unavailable response. Local tests cover this boundary; provider
sandbox/live, approved plan IDs, deployed OIDC/IAM/secrets and staging
recovery remain launch gates.

Razorpay's current guidance requires HMAC-SHA256 over the raw request body and identifies duplicate webhook deliveries with `x-razorpay-event-id`. See the official [webhook validation documentation](https://razorpay.com/docs/webhooks/validate-test/?locale=en-US).
