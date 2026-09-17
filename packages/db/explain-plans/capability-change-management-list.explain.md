# capability-change-management-list — EXPLAIN plan artifact (CTL phase 2 Lane A, migration 0152)

Function: `app_private.staff_list_capability_changes(text, integer)`
Defined at: `packages/db/migrations/0152_v1_ctl_change_management.sql:474` (block spans through its terminating `$$;`)

## Why this artifact exists even though it is not overlay-facing

This function is not caught by `scan-required-queries.mjs`'s three rules: it is not `list_overlay_*`
(rule 1), it does not live in a file whose name contains `overlay`/`master-canvas` (rule 2), and
`apps/api/src/db/capability-change-management-store.ts` is wired in `apps/api/src/index.ts` with the
MAIN pool `sql`, never `derivedReadSql` (rule 3 only follows `derivedReadSql`-tagged calls) — this is
a platform-staff governance write surface, not a widget/dashboard read. It is captured anyway,
manifested here as CTL phase 1's own `capability-resolution.explain.md` was for the identical
reason: the task's own instructions for this vertical slice require an explain-plan entry regardless
of overlay-facing status, and `staff_list_capability_changes` is the one query in this migration
shaped like the widget-backing aggregate reads this directory otherwise exists to catch (a per-row
correlated-subquery aggregate over an unbounded table), so it is the representative capture for this
migration's whole function set (`apply_due_capability_change`, `capability_change_row`, and every
`staff_*` function funnel through the identical two-subquery approval-count shape this file
documents).

## Exact query run

Seeded staff id: `00000000-0000-4000-8000-000000006c00` (`is_platform_admin = true`). Two seeded
`capability_change_requests` rows (`explain_probe_widget`, `explain_probe_seat`), both freshly
proposed via `app_private.staff_propose_capability_change`, `pending_approval`, zero approvals.
`ANALYZE` was run before capture.

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM app_private.staff_list_capability_changes(NULL, 50);
```

The call returns exactly the CTL-06/07/08/09 change-request projection asserted in
`packages/db/tests/ctl_change_management.sql`'s own `information_schema.parameters` check: `id,
capability_key, change_kind, status, proposed_capacity_class, proposed_description,
proposed_kill_switch, proposed_rollout_percentage, proposed_min_tier, effective_at,
requires_owner_signoff, staff_approval_count, owner_approval_count, created_by, created_at,
applied_at, decided_at, reason` — eighteen columns, the same shape every other function in this
migration returns through `app_private.capability_change_row`.

query_hash: `758ddccb31e7ae5e778e5073f5dfec7f414add92bf50d6c6a17853e3d5ddee01`

Computed by extracting the exact text from the `create or replace function
app_private.staff_list_capability_changes(` line through the terminating `$$;` line (inclusive) out
of `packages/db/migrations/0152_v1_ctl_change_management.sql` as it exists at capture time, then
`sha256sum`-ing that extracted text verbatim (UTF-8, including original newlines/whitespace) — the
identical extraction `packages/db/explain-plans/check-plans.mjs` re-runs against the migration
file's CURRENT contents on every check.

captured_at: 2026-09-17T14:10:00Z
postgres_version: postgres:16-alpine (PostgreSQL 16.14 on aarch64-unknown-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit)

This EXPLAIN was captured against a minimally-seeded local database (one staff user, two change
requests), **not** FULL-PRODUCT-DEFINITION.md §37.4's production-scale dataset. It is a plan-shape
change detector only — proof the query still resolves to the same kind of plan as when it was last
captured — and it is **NOT** evidence that any §19.4 performance budget is met at production scale,
nor any form of production, provider, device, network or release readiness. §19.0's RT-07 remains
Blocked and is the only row that can supply that evidence. This function additionally carries its
own lazy-apply pass (a loop over every `approved`-and-due row calling
`app_private.apply_due_capability_change`, CTL-06) ahead of the listing query itself — at this seed
size neither seeded row is `approved`, so that loop iterates zero times and does not appear in the
plan below; its own shape is the same single-row `UPDATE ... WHERE id = $1` `apply_due_capability_change`
always performs, already exercised functionally (not plan-captured) in the SQL test file.

## Plan shape

Wrapper call: opaque `Function Scan on staff_list_capability_changes` (security definer, never
inlined — the same correction every other artifact in this directory carries). Unwrapped body: the
listing query itself, captured separately below with the same `WHERE target_status IS NULL OR
status = target_status` predicate substituted for a `NULL` filter (list-everything, the widest case)
and `LIMIT 50`.

**`Seq Scan on capability_change_requests cr`**, 2 rows, no filter pushed to the base scan (the
`target_status IS NULL` branch reads the whole table at this seed size — the query planner cannot
push `OR` conditions on parameters into an index scan in this shape). `capability_change_requests_status_idx`
(status, effective_at) and `capability_change_requests_capability_key_idx` (capability_key, status)
both exist (confirmed in the capture run's own index listing, reproduced below) and are declined by
the planner here for the same reason every other near-empty-table lookup in this directory is: two
rows is cheaper as a sequential scan than an index lookup. At production scale, a `status = $1`-only
filter (the common case — an admin panel almost always lists one status) is exactly where
`capability_change_requests_status_idx` would be expected to engage; this artifact is not that
evidence (see the production-scale caveat above).

**Two `SubPlan`s per row** — `staff_approval_count` and `owner_approval_count`, each a correlated
`COUNT(*)` over `capability_change_approvals` filtered by `change_request_id` and `approval_kind`.
Both run as `Seq Scan on capability_change_approvals` (`loops=2` at this seed size — two change
requests), each returning zero rows (no approvals recorded against either seeded row in this
fixture). `capability_change_approvals_change_request_id_approver_id_key` (a UNIQUE index on
`change_request_id, approver_id` — CTL-07's maker-checker uniqueness constraint) is a composite key
starting with `change_request_id`, so it COULD serve this lookup; the planner declines it here for
the same near-empty-table reason as every other index in this directory at this seed size. At
production scale, with many approval rows per change and many change requests, these two subplans
are exactly where that composite index (its `change_request_id`-leading shape doubles as this
lookup's index, without a bespoke `change_request_id`-only index) would be expected to engage.

## Raw EXPLAIN output — literal function-call query

```
Function Scan on staff_list_capability_changes  (cost=0.25..10.25 rows=1000 width=302) (actual time=0.808..0.809 rows=2 loops=1)
  Buffers: shared hit=304
Planning Time: 0.019 ms
Execution Time: 0.817 ms
```

## Raw EXPLAIN output — supplementary: the unwrapped listing query, status filter NULL, limit 50

```
Limit  (cost=1.09..1.09 rows=2 width=177) (actual time=0.037..0.038 rows=2 loops=1)
  Buffers: shared hit=7
  ->  Sort  (cost=1.09..1.09 rows=2 width=177) (actual time=0.036..0.037 rows=2 loops=1)
        Sort Key: cr.created_at DESC, cr.id DESC
        Sort Method: quicksort  Memory: 25kB
        Buffers: shared hit=7
        ->  Seq Scan on capability_change_requests cr  (cost=0.00..1.08 rows=2 width=177) (actual time=0.011..0.013 rows=2 loops=1)
              Buffers: shared hit=1
              SubPlan 1
                ->  Aggregate  (cost=0.00..0.02 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=2)
                      ->  Seq Scan on capability_change_approvals a  (cost=0.00..0.00 rows=1 width=0) (actual time=0.000..0.000 rows=0 loops=2)
                            Filter: ((change_request_id = cr.id) AND (approval_kind = 'staff'::text))
              SubPlan 2
                ->  Aggregate  (cost=0.00..0.02 rows=1 width=4) (actual time=0.000..0.001 rows=1 loops=2)
                      ->  Seq Scan on capability_change_approvals a_1  (cost=0.00..0.00 rows=1 width=0) (actual time=0.000..0.000 rows=0 loops=2)
                            Filter: ((change_request_id = cr.id) AND (approval_kind = 'owner'::text))
Planning:
  Buffers: shared hit=213
Planning Time: 0.532 ms
Execution Time: 0.087 ms
```

## Indexes confirmed present at capture time

```
 capability_change_approvals | capability_change_approvals_change_request_id_approver_id_key | CREATE UNIQUE INDEX ... USING btree (change_request_id, approver_id)
 capability_change_approvals | capability_change_approvals_pkey                              | CREATE UNIQUE INDEX ... USING btree (id)
 capability_change_requests  | capability_change_requests_capability_key_idx                 | CREATE INDEX ... USING btree (capability_key, status)
 capability_change_requests  | capability_change_requests_pkey                               | CREATE UNIQUE INDEX ... USING btree (id)
 capability_change_requests  | capability_change_requests_status_idx                         | CREATE INDEX ... USING btree (status, effective_at)
```
