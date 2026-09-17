# public-capability-matrix — EXPLAIN plan artifact (CTL-10/CTL-11, migration 0160)

Function: `app_private.get_public_capability_matrix()`
Defined at: `packages/db/migrations/0160_v1_ctl_public_capability_matrix.sql:596` (block spans through its terminating `$$;`)

## Exact query run

Seeded staff id: `00000000-0000-4000-8000-000000009995`. Three seeded `capability_registry` rows
(`rt12_capture_pubmatrix_widget`, marketing_visible; `rt12_capture_pubmatrix_hidden`, NOT
marketing_visible; `rt12_capture_pubmatrix_section`, a marketing-section row via
`staff_create_marketing_section`), then one publish
(`app_private.staff_publish_capability_matrix_snapshot`) producing snapshot version 1 with
`row_count = 2` (the hidden widget correctly excluded). `ANALYZE` was run on
`capability_matrix_snapshots` and `capability_registry` before capture.

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM app_private.get_public_capability_matrix();
```

The call returns exactly two rows (the marketing_visible widget and the marketing-section row),
each with exactly seven columns: `capability_id, marketing_label, marketing_blurb, min_tier,
is_marketing_section, snapshot_version, published_at` — asserted by
`packages/db/tests/ctl_public_capability_matrix.sql` directly against
`information_schema.parameters`. **This is CTL-10's public-leak proof as a plan shape, not only as
a returned-column assertion**: there is no scan of `capability_registry` anywhere in this plan at
all (unlike `capability-resolution.explain.md`'s cache-miss path, which does scan the registry) —
the public path reads ONLY `capability_matrix_snapshots`, on every call, with no code path back to
the fields CTL-10 must never expose.

query_hash: `5359b820cb1c4128f1974453cd0fa9d5ede88be63ac6ea65a8fb74074124b6d6`

Computed by extracting the exact text from the `create or replace function
app_private.get_public_capability_matrix(` line through the terminating `$$;` line (inclusive) out
of `packages/db/migrations/0160_v1_ctl_public_capability_matrix.sql` as it exists at capture time,
then `sha256sum`-ing that extracted text verbatim (UTF-8, including original newlines/whitespace).
This is the identical extraction `packages/db/explain-plans/check-plans.mjs` re-runs against the
migration file's CURRENT contents on every check; a hash mismatch means the function body changed
since this artifact was captured and the plan needs re-verification.

captured_at: 2026-09-17T18:17:00Z
postgres_version: postgres:16-alpine (PostgreSQL 16.14 on aarch64-unknown-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit)

This EXPLAIN was captured against a minimally-seeded local database (one staff user, three
`capability_registry` rows, one published snapshot), **not** FULL-PRODUCT-DEFINITION.md §37.4's
production-scale dataset. It is a plan-shape change detector only — proof the query still resolves
to the same kind of plan as when it was last captured — and it is **NOT** evidence that any §19.4
performance budget is met at production scale, nor any form of production, provider, device,
network or release readiness. §19.0's RT-07 remains Blocked and is the only row that can supply
that evidence.

## Plan shape

Wrapper call: opaque `Function Scan on get_public_capability_matrix` (security definer, never
inlined — the same correction every other artifact in this directory carries; see
`qr-smart-card.explain.md`'s own note for the general shape). Unwrapped body: the function runs
exactly two statements — (1) find the latest snapshot by `order by version desc limit 1`, (2)
`jsonb_array_elements` its `rows` column into individual output rows — captured separately below
with literal values substituted, since PL/pgSQL's own security-definer wrapper hides both from the
literal-call plan above.

**Buffers: shared hit=404** for the wrapped call — consistent with every other opaque-Function-Scan
wrapper artifact in this directory (PL/pgSQL's own call/catalog overhead dominates at this seed
size, not the two statements themselves, which individually touch single-digit buffer counts — see
below). 1.448 ms execution time.

**Statement 1 — find the latest snapshot** (`order by s.version desc limit 1`):
`Seq Scan on capability_matrix_snapshots s`, `Buffers: shared hit=1` at the unwrapped level (one row
exists at this seed size), sorted (`Sort Method: quicksort`) and limited to one. The unique index
`capability_matrix_snapshots_version_idx` exists (confirmed in the capture run's own index listing,
reproduced below) and is declined by the planner at this seed size (one row) for the same reason
every other near-empty-table lookup in this directory is: an index lookup buys nothing over a
sequential scan of a one-row table. At production scale (many published snapshots), this is exactly
where `capability_matrix_snapshots_version_idx` would be expected to engage for a `ORDER BY version
DESC LIMIT 1` access pattern — this artifact is not that evidence (see the production-scale caveat
above).

**Statement 2 — unnest the latest snapshot's rows**: `InitPlan` re-reads the one snapshot row by
literal `version = 1` (`Seq Scan on capability_matrix_snapshots`, `Buffers: shared hit=1` — the
function's own two statements each re-read the snapshot table independently rather than sharing a
single read; two single-row reads of a one-row table is not a cost concern at any seed size this
schema's snapshot cadence implies, publishes being an infrequent staff action, not a per-request
write), then `Function Scan on jsonb_array_elements`, `Buffers: shared hit=1`, unnesting the two-row
`rows` jsonb array and sorting by `capability_id` (the `order by` this migration's function body
adds for deterministic output ordering, not present in `resolve_channel_capabilities`'s own
`jsonb_object_agg` which has no row order to begin with).

**No scan of `capability_registry`, `capability_denylist`, `capability_overrides`,
`capability_allowlist`, or any other CTL table appears anywhere in this plan, at any seed size, by
construction** — the code path never issues such a query (see the migration's own CTL-10 section).
This is the structural half of CTL-10's public-leak proof: even if a future edit accidentally
widened `get_public_capability_matrix`'s SELECT list, the query planner would have to start scanning
`capability_registry` to satisfy it, which this artifact's own re-capture (triggered by
`check-plans.mjs`'s hash check on any body change) would surface as a plan-shape change, not a
silent widening.

## Raw EXPLAIN output — literal function-call query

```
Function Scan on get_public_capability_matrix  (cost=0.25..10.25 rows=1000 width=141) (actual time=1.432..1.433 rows=2 loops=1)
  Buffers: shared hit=404
Planning Time: 0.038 ms
Execution Time: 1.448 ms
```

## Raw EXPLAIN output — unwrapped statement 1 (find the latest snapshot)

```
Limit  (cost=1.02..1.02 rows=1 width=473) (actual time=0.027..0.028 rows=1 loops=1)
  Buffers: shared hit=4
  ->  Sort  (cost=1.02..1.02 rows=1 width=473) (actual time=0.027..0.027 rows=1 loops=1)
        Sort Key: version DESC
        Sort Method: quicksort  Memory: 25kB
        Buffers: shared hit=4
        ->  Seq Scan on capability_matrix_snapshots s  (cost=0.00..1.01 rows=1 width=473) (actual time=0.003..0.003 rows=1 loops=1)
              Buffers: shared hit=1
Planning:
  Buffers: shared hit=97
Planning Time: 0.294 ms
Execution Time: 0.054 ms
```

## Raw EXPLAIN output — unwrapped statement 2 (unnest the latest snapshot's rows, literal version = 1)

```
Sort  (cost=7.34..7.59 rows=100 width=141) (actual time=0.048..0.048 rows=2 loops=1)
  Sort Key: ((elem.value ->> 'capability_id'::text))
  Sort Method: quicksort  Memory: 25kB
  Buffers: shared hit=4
  InitPlan 1 (returns $0)
    ->  Seq Scan on capability_matrix_snapshots  (cost=0.00..1.01 rows=1 width=461) (actual time=0.006..0.006 rows=1 loops=1)
          Filter: (version = 1)
          Buffers: shared hit=1
  ->  Function Scan on jsonb_array_elements elem  (cost=0.00..3.00 rows=100 width=141) (actual time=0.027..0.028 rows=2 loops=1)
        Buffers: shared hit=1
Planning:
  Buffers: shared hit=104
Planning Time: 0.322 ms
Execution Time: 0.077 ms
```

## Index listing (capture-time confirmation, both tables this function touches)

```
capability_registry_pkey                | CREATE UNIQUE INDEX capability_registry_pkey ON public.capability_registry USING btree (id)
capability_registry_capability_key_key  | CREATE UNIQUE INDEX capability_registry_capability_key_key ON public.capability_registry USING btree (capability_key)
capability_matrix_snapshots_pkey        | CREATE UNIQUE INDEX capability_matrix_snapshots_pkey ON public.capability_matrix_snapshots USING btree (id)
capability_matrix_snapshots_version_idx | CREATE UNIQUE INDEX capability_matrix_snapshots_version_idx ON public.capability_matrix_snapshots USING btree (version)
```

(`capability_registry`'s own indexes are listed for completeness only — this function's plan never
scans that table at all, as established above.)
