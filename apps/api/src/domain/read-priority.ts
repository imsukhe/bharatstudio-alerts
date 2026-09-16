// RT-10 / RT-11 (FULL-PRODUCT-DEFINITION.md §19.0, §31.18.0): payment traffic
// must never queue behind a widget, dashboard or analytics read, and a
// pathological read must fail fast rather than hold a connection a payment
// needs. Both rows key off the SAME classification so the "which routes are
// payment-class, which are widget/analytics-class" answer cannot drift
// between the two mechanisms (§5 of the owning command).
//
// Structural protection, not just a list: this classifier is only ever
// consulted for GET requests (see `classifyReadPriority`'s `method !== 'GET'`
// short-circuit). Every payment write, webhook commit, alert delivery and
// overlay event this TypeScript API exposes is a POST/PUT/DELETE — or lives
// entirely in a separate Go service with its own database connections
// (`payment-webhook-go`, `alert-worker-go`) that this module never touches —
// so RT-10.4 and RT-11.2 hold by construction, not by a classification that
// could be gotten wrong.
//
// Fail-safe direction (§2 of the owning command): a route this module does
// not explicitly name EXEMPT is DERIVED_READ, never EXEMPT. The failure
// RT-10 exists to prevent is a misclassified read starving a payment, so an
// unclassified GET route must fail toward the LOWER priority, not the
// higher one — see `classifyReadPriority`'s default branch.

export type ReadPriorityClass = 'exempt' | 'derived_read';

// Durable/payment-adjacent GET reads that must never be shed (RT-10) or
// timed out (RT-11), named individually with the reason each is exempt
// rather than governed:
//
//   - the overlay SSE stream is the RT-01/RT-02 durable live-event path
//     itself, not a derived view of it;
//   - tip-order and tip-intent status are a supporter polling to see
//     whether their OWN payment succeeded — a read leg of the payment flow,
//     not an aggregate/derived view (goal totals, leaderboards, etc.);
//   - the overlay session/cursor endpoints back the same durable replay
//     path RT-01/RT-02 protect, not a widget snapshot.
const EXEMPT_GET_ROUTES: ReadonlySet<string> = new Set([
  '/v1/overlays/:overlayId/events',
  '/v1/overlays/:overlayId',
  '/v1/overlays/:overlayId/cursor',
  '/v1/public/tip-orders/:orderId/status',
  '/v1/public/tip-intents/:token',
]);

// Operational surfaces (health, readiness, metrics scraping) are neither
// payment traffic nor a derived product read — RT-06's own budget
// classifier already excludes `/internal/*` for the identical reason
// (apps/api/src/observability/metrics.ts `classifyBudgetedPath`).
function isOperationalRoute(route: string): boolean {
  return route.startsWith('/internal/') || route === '/healthz' || route === '/readyz' || route === 'unknown';
}

/**
 * Classifies one HTTP request for RT-10 (backpressure) and RT-11 (read
 * timeout). Returns `null` for anything that is not a governed read surface
 * at all — every non-GET request — so a caller that sees `null` must apply
 * neither shedding nor a statement timeout, unconditionally. This is the
 * single chokepoint both rows share; do not duplicate this list elsewhere.
 */
export function classifyReadPriority(method: string, route: string): ReadPriorityClass | null {
  if (method !== 'GET') return null;
  if (isOperationalRoute(route)) return 'exempt';
  if (EXEMPT_GET_ROUTES.has(route)) return 'exempt';
  return 'derived_read';
}
