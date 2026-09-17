# emergency-kill-list — EXPLAIN plan artifact (§20.6.1, migration 0155, Job 2)

Function: `app_private.staff_list_kill_events(text, integer)`
Defined at: `packages/db/migrations/0155_v1_ctl_emergency_kill_and_owner.sql:1352` (block spans through its terminating `$$;`)

## Why this artifact exists even though it is not overlay-facing

This function is not caught by `scan-required-queries.mjs`'s three rules: it is not `list_overlay_*`
(rule 1), it does not live in a file whose name contains `overlay`/`master-canvas` (rule 2), and
`apps/api/src/db/capability-kill-events-store.ts` is wired in `apps/api/src/index.ts` with the MAIN
pool `sql`, never `derivedReadSql` (rule 3 only follows `derivedReadSql`-tagged calls) — this is a
platform-staff emergency-response surface, not a widget/dashboard read. It is captured anyway, for
the identical reason `capability-change-management-list.explain.md` (migration 0152) was: this
vertical slice's own instructions require an explain-plan entry regardless of overlay-facing status,
and `staff_list_kill_events` is the representative capture for this migration's whole Job 2 function
set — `staff_fire_global_kill`, `staff_ratify_kill_event`, `staff_propose_kill_extension`,
`staff_approve_kill_extension` and `staff_file_kill_review` all return through the identical shared
row-shaping helper (`app_private.capability_kill_event_row`) this listing query exercises per row via
a `LATERAL` join, including that helper's own lazy auto-revert call
(`app_private.apply_due_kill_revert`) ahead of every read.

## Exact query run

Seeded staff ids: `00000000-0000-4000-8000-0000000ee001`, `00000000-0000-4000-8000-0000000ee002`
(both `is_platform_admin = true`). Two capabilities (`explain_probe_widget`, `explain_probe_seat`),
each fired once via `app_private.staff_fire_global_kill` and immediately reviewed via
`app_private.staff_file_kill_review` (so the representative capture is not itself blocked by the
review-blocks-next-kill rule). `ANALYZE` was run before capture.

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM app_private.staff_list_kill_events(NULL, 50);
```

The call returns exactly the sixteen-column `CapabilityKillEvent` projection this migration's own
`app_private.capability_kill_event_row` shapes: `id, capability_key, fired_by, fired_at, reason,
affected_channel_count, live_channel_count, expires_at, ratified_by, ratified_at,
escalated_to_owner, reverted, reviewed, reviewed_by, reviewed_at, review_text` — the same shape every
other Job 2 function returns through that one helper.

query_hash: `c174e44ef88c5bc476c0e3c96ba55264bdca62c2fc01df3c955a75b68ad6051f`

Computed by extracting the exact text from the `create or replace function
app_private.staff_list_kill_events(` line through the terminating `$$;` line (inclusive) out of
`packages/db/migrations/0155_v1_ctl_emergency_kill_and_owner.sql` as it exists at capture time, then
`sha256sum`-ing that extracted text verbatim (UTF-8, including original newlines/whitespace) — the
identical extraction `packages/db/explain-plans/check-plans.mjs` re-runs against the migration file's
CURRENT contents on every check.

captured_at: 2026-09-17T16:18:00Z
postgres_version: postgres:16-alpine (PostgreSQL 16.14 on aarch64-unknown-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit)

This EXPLAIN was captured against a minimally-seeded local database (two staff users, two kill
events), **not** FULL-PRODUCT-DEFINITION.md §37.4's production-scale dataset. It is a plan-shape
change detector only — proof the query still resolves to the same kind of plan as when it was last
captured — and it is **NOT** evidence that any §19.4 performance budget is met at production scale,
nor any form of production, provider, device, network or release readiness. §19.0's RT-07 remains
Blocked and is the only row that can supply that evidence.

## Plan shape

Wrapper call: opaque `Function Scan on staff_list_kill_events` (security definer, never inlined — the
same correction every other artifact in this directory carries). Unwrapped body: the listing query
itself, captured separately below with the function's own `WHERE target_capability_key IS NULL OR
capability_key = target_capability_key` predicate substituted for a `WHERE true` (list-everything,
the widest case) and `LIMIT 50` — this migration's lazy-apply loop (every kill event's
`app_private.apply_due_kill_revert` called ahead of the listing query) is not separately visible in
this plan: it is a plain per-row `SELECT`/no-op at this seed size (neither seeded kill event's
effective expiry has passed), and its own single-row-restore shape is already exercised functionally,
not plan-captured, in `packages/db/tests/ctl_emergency_kill_and_owner.sql`'s own auto-revert test.

**`Seq Scan on capability_kill_events ev`**, 2 rows, no filter pushed to the base scan (the
`WHERE true` branch reads the whole table at this seed size). `capability_kill_events_capability_idx`
(capability_key, fired_at) and `capability_kill_events_fired_by_idx` (fired_by, fired_at) both exist
(confirmed in the capture run's own index listing, reproduced below) and are declined by the planner
here for the same reason every other near-empty-table lookup in this directory is: two rows is
cheaper as a sequential scan than an index lookup. At production scale, a `capability_key = $1`-only
filter (the common case — an admin panel almost always lists one capability's incident history) is
exactly where `capability_kill_events_capability_idx` would be expected to engage; this artifact is
not that evidence (see the production-scale caveat above).

**One `Function Scan on capability_kill_event_row "row"` per outer row** (a `LATERAL` join,
`loops=2` at this seed size) — the shared row-shaping helper, itself opaque to this outer `EXPLAIN`
(security definer, never inlined) exactly as `staff_list_kill_events` itself is opaque to the wrapper
call above it. Its own internals (a lazy auto-revert check, then a three-way `LEFT JOIN` across
`capability_kill_ratifications` and `capability_kill_reviews` keyed by `kill_event_id`, both served
by their own `UNIQUE(kill_event_id)` index at production volume) are not visible inside THIS plan for
the same opacity reason `capability_change_row` is opaque inside `staff_list_capability_changes`'s own
artifact.

## Raw EXPLAIN output — literal function-call query

```
Function Scan on staff_list_kill_events  (cost=0.25..10.25 rows=1000 width=203) (actual time=3.993..3.993 rows=2 loops=1)
  Buffers: shared hit=949
Planning Time: 0.015 ms
Execution Time: 4.006 ms
```

## Raw EXPLAIN output — supplementary: the unwrapped listing query, capability filter NULL, limit 50

```
Limit  (cost=107.71..107.83 rows=50 width=227) (actual time=2.318..2.318 rows=2 loops=1)
  Buffers: shared hit=389
  ->  Sort  (cost=107.71..112.71 rows=2000 width=227) (actual time=2.317..2.317 rows=2 loops=1)
        Sort Key: ev.fired_at DESC, ev.id DESC
        Sort Method: quicksort  Memory: 25kB
        Buffers: shared hit=389
        ->  Nested Loop  (cost=0.25..41.27 rows=2000 width=227) (actual time=2.033..2.292 rows=2 loops=1)
              Buffers: shared hit=383
              ->  Seq Scan on capability_kill_events ev  (cost=0.00..1.02 rows=2 width=24) (actual time=0.009..0.009 rows=2 loops=1)
                    Buffers: shared hit=1
              ->  Function Scan on capability_kill_event_row "row"  (cost=0.25..10.25 rows=1000 width=203) (actual time=1.139..1.139 rows=1 loops=2)
                    Buffers: shared hit=382
Planning:
  Buffers: shared hit=136
Planning Time: 0.370 ms
Execution Time: 2.355 ms
```

## Indexes confirmed present at capture time

```
 capability_kill_events              | capability_kill_events_capability_idx                        | CREATE INDEX ... USING btree (capability_key, fired_at)
 capability_kill_events              | capability_kill_events_fired_by_idx                          | CREATE INDEX ... USING btree (fired_by, fired_at)
 capability_kill_events              | capability_kill_events_pkey                                  | CREATE UNIQUE INDEX ... USING btree (id)
 capability_kill_extension_approvals | capability_kill_extension_approvals_extension_request_id_key | CREATE UNIQUE INDEX ... USING btree (extension_request_id)
 capability_kill_extension_approvals | capability_kill_extension_approvals_pkey                     | CREATE UNIQUE INDEX ... USING btree (id)
 capability_kill_extension_requests  | capability_kill_extension_requests_pkey                      | CREATE UNIQUE INDEX ... USING btree (id)
 capability_kill_ratifications       | capability_kill_ratifications_kill_event_id_key              | CREATE UNIQUE INDEX ... USING btree (kill_event_id)
 capability_kill_ratifications       | capability_kill_ratifications_pkey                           | CREATE UNIQUE INDEX ... USING btree (id)
 capability_kill_reviews             | capability_kill_reviews_kill_event_id_key                    | CREATE UNIQUE INDEX ... USING btree (kill_event_id)
 capability_kill_reviews             | capability_kill_reviews_pkey                                 | CREATE UNIQUE INDEX ... USING btree (id)
```
