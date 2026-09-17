# capability-resolution — EXPLAIN plan artifact (RT-12; CTL phase 1, capability control plane)

Function: `app_private.get_channel_capabilities(uuid)`
Defined at: `packages/db/migrations/0149_v1_ctl_capability_control_plane.sql:522` (block spans through its terminating `$$;`)

## Exact query run

Seeded owner id: `00000000-0000-4000-8000-000000009996`
Seeded staff id: `00000000-0000-4000-8000-000000009997`
Seeded channel id: `00000000-0000-4000-8000-000000009998` (pro tier)
Two seeded capability_registry rows (`rt12_capture_widget`, min_tier pro; `rt12_capture_seat`, min_tier studio), no denylist/override rows. `ANALYZE` was run before capture.

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM app_private.get_channel_capabilities('00000000-0000-4000-8000-000000009998'::uuid);
```

The call returns exactly one row: `resolved = {"rt12_capture_widget": true, "rt12_capture_seat": false}`, `generation`, `resolved_at`. **Three columns. That is the whole projection** — no per-capability row, no channel id in the row itself — asserted by `packages/db/tests/ctl_capability_registry.sql` directly against `information_schema.parameters` (`resolved,generation,resolved_at`, nothing else).

CTL-03's "never per-capability queries" is what this artifact exists to make visible as a plan shape, not only as a returned-column assertion: the SAME call, run TWICE in sequence with nothing else changing, produces two structurally different plans underneath the identical opaque `Function Scan` wrapper — a cache MISS (the first call, capability_resolutions has no row yet for this channel) and a cache HIT (the second call, the row now exists and both the generation and the channel's tier still match). The two are captured separately below.

query_hash: `e78c88227673c6ae6f1e4dbbc5e124472e053490bbafa1ff22a130455527ab1e`

Computed by extracting the exact text from the `create or replace function app_private.get_channel_capabilities(` line through the terminating `$$;` line (inclusive) out of `packages/db/migrations/0149_v1_ctl_capability_control_plane.sql` as it exists at capture time, then `sha256sum`-ing that extracted text verbatim (UTF-8, including original newlines/whitespace). This is the identical extraction `packages/db/explain-plans/check-plans.mjs` re-runs against the migration file's CURRENT contents on every check; a hash mismatch means the function body changed since this artifact was captured and the plan needs re-verification. Only `get_channel_capabilities`'s own body is hashed — its one-line delegation to `app_private.resolve_channel_capabilities` is what check-plans.mjs verifies; the deeper plans below (resolve_channel_capabilities' cache-hit read and cache-miss aggregate) are captured for this artifact's own honesty about where the real plan shape lives, but are not independently hash-checked.

captured_at: 2026-09-17T00:00:00Z
postgres_version: postgres:16-alpine (PostgreSQL 16.14 on aarch64-unknown-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit)

This EXPLAIN was captured against a minimally-seeded local database (one channel, two capability_registry rows), **not** FULL-PRODUCT-DEFINITION.md §37.4's production-scale dataset. It is a plan-shape change detector only — proof the query still resolves to the same kind of plan as when it was last captured — and it is **NOT** evidence that any §19.4 performance budget is met at production scale, nor any form of production, provider, device, network or release readiness. §19.0's RT-07 remains Blocked and is the only row that can supply that evidence.

## Plan shape

Wrapper call: opaque `Function Scan on get_channel_capabilities` (security definer, never inlined — the same correction every other artifact in this directory carries; see `qr-smart-card.explain.md`'s own note for the general shape). Unwrapped body: `get_channel_capabilities` is a one-line delegation (`return query select * from app_private.resolve_channel_capabilities(target_channel_id)`, after its `has_channel_role` gate), so the real plan shape lives one level further in, inside `resolve_channel_capabilities` itself — captured below with the exact literal channel id substituted, for both of its two code paths.

**Cache MISS (first call for this channel)**: `Buffers: shared hit=595 read=5 dirtied=3 written=2`, 1.858 ms. This is the more expensive path — `resolve_channel_capabilities` finds no `capability_resolutions` row, so it aggregates every `capability_registry` row, checks `capability_denylist`/`capability_overrides` per row via `EXISTS`/scalar subqueries, computes the rollout bucket, and `INSERT ... ON CONFLICT DO UPDATE`s the cache row — the bulk of the buffer traffic is PL/pgSQL's own security-definer call/catalog overhead (consistent with every other opaque-Function-Scan wrapper artifact in this directory) plus the one cache-row write.

**Cache HIT (second call, nothing changed)**: `Buffers: shared hit=5`, 0.178 ms — roughly 10x fewer buffer hits and no `dirtied`/`written` pages at all. This is CTL-03's fast path: `resolve_channel_capabilities` reads exactly one row from `capability_resolutions` (`Seq Scan on capability_resolutions c … Filter: (channel_id = …)`, `Buffers: shared hit=1` at the unwrapped level) and returns it — no scan of `capability_registry`, `capability_denylist` or `capability_overrides` at all on this path, at any seed size, by construction (the code path never issues those queries when the cache is valid — see the migration's own CTL-03 section).

**Both leaf scans in the recompute (cache-miss) path are sequential at this seed size, and both are honest rather than surprising:**

- **`Seq Scan on capability_registry reg`**, 2 rows, no filter (the whole table is aggregated — there is no channel-scoped predicate on this scan, by design: one pass over the registry produces every capability's answer for the channel in one query). `capability_registry_pkey` and `capability_registry_capability_key_key` both exist (confirmed in the capture run's own index listing, reproduced below) and are declined by the planner because this scan reads the WHOLE table, not a lookup by key.
- **`Seq Scan on capability_denylist d`** and **`Seq Scan on capability_overrides o`**, each run as a `SubPlan` once per `capability_registry` row (`loops=2` at this seed size — two registered capabilities), each returning zero rows (no denylist/override configured for this channel in this fixture). `capability_denylist_channel_idx` and `capability_overrides_channel_idx` both exist (confirmed below) and are declined by the planner at this seed size (two capability rows, zero denylist/override rows) for the same reason every other near-empty-table lookup in this directory is: an index lookup buys nothing over a sequential scan of an empty or near-empty table. At production scale (many denylist/override rows per capability, or many capabilities), these two subplans are exactly where `capability_denylist_channel_idx`/`capability_overrides_channel_idx` would be expected to engage — this artifact is not that evidence (see the production-scale caveat above).

The cache-hit read (`Seq Scan on capability_resolutions c`, `Filter: (channel_id = …)`) declines `capability_resolutions_pkey` for the same one-row-table reason every other single-row lookup in this directory records at this seed size.

## Raw EXPLAIN output — literal function-call query, cache MISS (first call)

```
Function Scan on get_channel_capabilities  (cost=0.25..10.25 rows=1000 width=48) (actual time=1.853..1.853 rows=1 loops=1)
  Buffers: shared hit=595 read=5 dirtied=3 written=2
Planning Time: 0.009 ms
Execution Time: 1.858 ms
```

## Raw EXPLAIN output — literal function-call query, cache HIT (second call, nothing changed)

```
Function Scan on get_channel_capabilities  (cost=0.25..10.25 rows=1000 width=48) (actual time=0.175..0.176 rows=1 loops=1)
  Buffers: shared hit=5
Planning Time: 0.009 ms
Execution Time: 0.178 ms
```

## Raw EXPLAIN output — supplementary: resolve_channel_capabilities' CACHE HIT path unwrapped, parameters substituted with the same seeded literal channel id

```
Seq Scan on capability_resolutions c  (cost=0.00..1.81 rows=1 width=48) (actual time=0.001..0.001 rows=1 loops=1)
  Filter: (channel_id = '00000000-0000-4000-8000-000000009998'::uuid)
  Buffers: shared hit=1
Planning Time: 0.008 ms
Execution Time: 0.002 ms
```

## Raw EXPLAIN output — supplementary: resolve_channel_capabilities' CACHE MISS / recompute aggregate unwrapped, parameters substituted with the same seeded literal channel id and tier ('pro')

```
Aggregate  (cost=1.59..1.60 rows=1 width=32) (actual time=0.033..0.034 rows=1 loops=1)
  Buffers: shared hit=1
  ->  Seq Scan on capability_registry reg  (cost=0.00..1.02 rows=2 width=29) (actual time=0.002..0.002 rows=2 loops=1)
        Buffers: shared hit=1
  SubPlan 1
    ->  Seq Scan on capability_denylist d  (cost=0.00..0.00 rows=1 width=0) (actual time=0.002..0.002 rows=0 loops=2)
          Filter: ((capability_key = reg.capability_key) AND (channel_id = '00000000-0000-4000-8000-000000009998'::uuid))
  SubPlan 3
    ->  Seq Scan on capability_overrides o  (cost=0.00..0.00 rows=1 width=1) (actual time=0.000..0.000 rows=0 loops=2)
          Filter: ((capability_key = reg.capability_key) AND (channel_id = '00000000-0000-4000-8000-000000009998'::uuid))
Planning:
  Buffers: shared hit=6
Planning Time: 0.100 ms
Execution Time: 0.046 ms
```

(`SubPlan 2` is the rollout-bucket scalar function call, `app_private.capability_rollout_bucket` — a plain SQL-language `immutable` function on md5 arithmetic, not a table scan, so it does not appear as its own numbered scan node here; PostgreSQL's own SubPlan numbering skips from 1 to 3 for exactly this reason.)

## Indexes confirmed present at capture time

```
 capability_denylist            | capability_denylist_channel_idx        | CREATE INDEX capability_denylist_channel_idx ON public.capability_denylist USING btree (channel_id)
 capability_denylist            | capability_denylist_pkey               | CREATE UNIQUE INDEX capability_denylist_pkey ON public.capability_denylist USING btree (capability_key, channel_id)
 capability_overrides           | capability_overrides_channel_idx       | CREATE INDEX capability_overrides_channel_idx ON public.capability_overrides USING btree (channel_id)
 capability_overrides           | capability_overrides_pkey              | CREATE UNIQUE INDEX capability_overrides_pkey ON public.capability_overrides USING btree (capability_key, channel_id)
 capability_registry            | capability_registry_capability_key_key | CREATE UNIQUE INDEX capability_registry_capability_key_key ON public.capability_registry USING btree (capability_key)
 capability_registry            | capability_registry_pkey               | CREATE UNIQUE INDEX capability_registry_pkey ON public.capability_registry USING btree (id)
 capability_registry_generation | capability_registry_generation_pkey    | CREATE UNIQUE INDEX capability_registry_generation_pkey ON public.capability_registry_generation USING btree (id)
 capability_resolutions         | capability_resolutions_pkey            | CREATE UNIQUE INDEX capability_resolutions_pkey ON public.capability_resolutions USING btree (channel_id)
```

(`capability_registry_audit` carries only its own `capability_registry_audit_key_idx` plus its primary key; it is not read by either code path above and is omitted here.)

## Addendum, 2026-09-17 — migration 0153's allowlist stage

Migration `0153` widened `app_private.resolve_channel_capabilities`'s cache-miss recompute (the
same function captured above, body-only `CREATE OR REPLACE` — its wrapper,
`app_private.get_channel_capabilities`, is untouched, so the hash `check-plans.mjs` verifies
against that wrapper's own body is unaffected and this addendum is not independently hash-checked,
consistent with the rest of this artifact's own documented scope) with one new `CASE` branch: a
per-row `EXISTS` check against the new `public.capability_allowlist` table, evaluated after
`capability_denylist` and ahead of the rollout-bucket check. Re-captured against a fresh
`postgres:16-alpine` container with the same three-seeded-capability shape as above plus one new
capability (`rt12_capture_allowlisted`, `min_tier` studio, channel tier pro) explicitly allowlisted
for the seeded channel:

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM app_private.get_channel_capabilities('00000000-0000-4000-8000-000000009998'::uuid);
```

Result: `resolved = {"rt12_capture_seat": false, "rt12_capture_widget": true,
"rt12_capture_allowlisted": true}` — `rt12_capture_allowlisted` resolves `true` despite the
channel's `pro` tier failing its `studio` `min_tier`, proving the allowlist stage decides ahead of
tier in a real captured plan, not only in the SQL test suite.

Plan shape: the recompute aggregate gains exactly one more `SubPlan` — a `Seq Scan on
capability_allowlist a` with the identical `Filter: (capability_key = reg.capability_key AND
channel_id = ...)` shape the existing `capability_denylist`/`capability_overrides` SubPlans already
have, and the identical `loops=<capability count>` per-row correlation. `capability_allowlist_pkey`
and `capability_allowlist_channel_idx` both exist (confirmed via `pg_indexes`, same as the other
CTL-02 support tables) and are declined by the planner at this seed size (three capabilities, one
allowlist row) for the same near-empty-table reason every other scan in this artifact already
documents. No change to the cache-HIT path's shape at all — that path (`Seq Scan on
capability_resolutions`) never touches `capability_registry`, `capability_denylist`,
`capability_overrides` OR `capability_allowlist`, by construction, unaffected by this migration.
This capture is the same plan-shape-change-detector caveat as the rest of this artifact: not
production-scale evidence, not a §19.4/RT-07 measurement.

```
Aggregate  (cost=4.92..4.93 rows=1 width=32) (actual time=0.031..0.031 rows=1 loops=1)
  Buffers: shared hit=4
  ->  Seq Scan on capability_registry reg  (cost=0.00..1.03 rows=3 width=32) (actual time=0.002..0.002 rows=3 loops=1)
        Buffers: shared hit=1
  SubPlan 1
    ->  Seq Scan on capability_denylist d  (cost=0.00..0.00 rows=1 width=0) (actual time=0.000..0.000 rows=0 loops=3)
          Filter: ((capability_key = reg.capability_key) AND (channel_id = '00000000-0000-4000-8000-000000009998'::uuid))
  SubPlan 3
    ->  Seq Scan on capability_allowlist a  (cost=0.00..1.01 rows=1 width=0) (actual time=0.001..0.001 rows=0 loops=3)
          Filter: ((capability_key = reg.capability_key) AND (channel_id = '00000000-0000-4000-8000-000000009998'::uuid))
          Rows Removed by Filter: 1
          Buffers: shared hit=3
  SubPlan 5
    ->  Seq Scan on capability_overrides o  (cost=0.00..0.00 rows=1 width=1) (actual time=0.000..0.000 rows=0 loops=2)
          Filter: ((capability_key = reg.capability_key) AND (channel_id = '00000000-0000-4000-8000-000000009998'::uuid))
Planning:
  Buffers: shared hit=6
Planning Time: 0.102 ms
Execution Time: 0.046 ms
```

(SubPlan numbering skips 2 and 4 for the same reason the original capture's own note explains:
`app_private.capability_rollout_bucket` scalar calls consume SubPlan slots without appearing as
their own scan node.)

captured_at: 2026-09-17T00:00:00Z · postgres_version: postgres:16-alpine (PostgreSQL 16.14)
