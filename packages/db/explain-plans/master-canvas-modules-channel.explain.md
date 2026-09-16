# master-canvas-modules-channel — EXPLAIN plan artifact (RT-12, closed by PRF-02 slice 2)

Function: `app_private.list_channel_master_canvas_modules(uuid)`
Defined at: `packages/db/migrations/0131_v1_prf02_master_canvas_modules.sql:126` (block spans lines 126-162)

This is the second of the two artifacts PRF-02 slice 2's own command named explicitly (this task's
§1(a)). Unlike every other artifact in this directory, this function is **creator-facing** (session-
authenticated dashboard read of a channel's own configured modules — active state and inactive
reason), not `overlay_sessions`-token-gated like `list_overlay_*` reads. It does not match the
`list_overlay_*` naming convention `scan-required-queries.mjs` keys on, so it is present in
`required-queries.json` only by explicit addition, not because the general-purpose scan would ever
nominate it — see `required-queries.json`'s own top-level comment for why.

## Exact query run

Target channel id: `00000000-0000-4000-8000-000000000011` (base_world channel, session variable
`app.user_id` set to its owner, `00000000-0000-4000-8000-000000000001`, per `has_channel_role`'s
authorization check inside the function).

```sql
set app.user_id = '00000000-0000-4000-8000-000000000001';
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM app_private.list_channel_master_canvas_modules('00000000-0000-4000-8000-000000000011'::uuid);
```

query_hash: `6c100c9dc50141d0f3126e35592e9c85390198e7a991baec80a34a6e6e544a05`

Computed by extracting the exact text from the `create or replace function app_private.list_channel_master_canvas_modules(` line through the terminating `$$;` line (inclusive) out of `packages/db/migrations/0131_v1_prf02_master_canvas_modules.sql` as it exists at capture time, then `sha256sum`-ing that extracted text verbatim (UTF-8, including original newlines/whitespace). This is the identical extraction `packages/db/explain-plans/check-plans.mjs` re-runs against the migration file's CURRENT contents on every check; a hash mismatch means the function body changed since this artifact was captured and the plan needs re-verification.

captured_at: 2026-09-16T00:00:00Z
postgres_version: postgres:16-alpine (PostgreSQL 16.14 on aarch64-unknown-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit)

This EXPLAIN was captured against an unseeded/minimally-seeded local database (a handful of synthetic rows: three configured master_canvas_modules rows for one channel), not FULL-PRODUCT-DEFINITION.md §37.4's production-scale dataset. It is a plan-shape change detector only — proof that the query still resolves to the same kind of plan (index scan vs. sequential scan) as when it was last captured — and it is NOT evidence that any §19.4 performance budget is met at production scale.

**Auth note specific to this capture**: the first attempt at the literal wrapper-call EXPLAIN, run in a fresh `psql` session with `app.user_id` unset, returned `rows=0` — not a query bug, but `has_channel_role`'s own correct fail-closed behavior when no caller identity is set (the same posture every other channel-role-gated function in this codebase takes). Re-run with `app.user_id` set to the channel's owner, it returns the expected 3 rows, matching the unwrapped capture below. Recorded here rather than silently re-run, per this task's own instruction to report rather than paper over a wrong first assumption.

## Plan shape

Wrapper call: opaque `Function Scan on list_channel_master_canvas_modules` (security definer, never inlined — see the correction on every other artifact in this directory, reproduced in full on `master-canvas-modules-overlay.explain.md`). Unwrapped body: fully resolved, no opaque sub-nodes — `Index Scan Backward using channel_entitlement_versions_pkey`, a `One-Time Filter` evaluating `has_channel_role` once (not per row), `WindowAgg` over a `Sort` fed by `Bitmap Heap Scan on master_canvas_modules` (via `master_canvas_modules_channel_idx`).

## Raw EXPLAIN output — literal function-call query (app.user_id set to the channel owner)

```
Function Scan on list_channel_master_canvas_modules  (cost=0.25..10.25 rows=1000 width=86) (actual time=2.506..2.507 rows=3 loops=1)
  Buffers: shared hit=760
Planning Time: 0.034 ms
Execution Time: 2.535 ms
```

## Raw EXPLAIN output — supplementary: function body unwrapped, parameters substituted with the same seeded literal values

This is the real plan for the SQL text covered by `query_hash` above (the function body, not the wrapper call).

```
Sort  (cost=20.37..20.38 rows=4 width=86) (actual time=0.699..0.700 rows=3 loops=1)
  Sort Key: module.created_at
  Sort Method: quicksort  Memory: 25kB
  Buffers: shared hit=143
  CTE tiered
    ->  Limit  (cost=0.15..6.17 rows=1 width=40) (actual time=0.006..0.006 rows=1 loops=1)
          Buffers: shared hit=2
          ->  Index Scan Backward using channel_entitlement_versions_pkey on channel_entitlement_versions  (cost=0.15..12.18 rows=2 width=40) (actual time=0.005..0.005 rows=1 loops=1)
                Index Cond: (channel_id = '00000000-0000-4000-8000-000000000011'::uuid)
                Buffers: shared hit=2
  InitPlan 2 (returns $1)
    ->  CTE Scan on tiered  (cost=0.00..0.27 rows=1 width=4) (actual time=0.117..0.117 rows=1 loops=1)
          Buffers: shared hit=5
  InitPlan 3 (returns $2)
    ->  CTE Scan on tiered tiered_1  (cost=0.00..0.27 rows=1 width=4) (never executed)
  InitPlan 4 (returns $3)
    ->  CTE Scan on tiered tiered_2  (cost=0.00..0.27 rows=1 width=4) (actual time=0.003..0.003 rows=1 loops=1)
  InitPlan 5 (returns $4)
    ->  CTE Scan on tiered tiered_3  (cost=0.00..0.27 rows=1 width=4) (never executed)
  ->  Result  (cost=12.93..13.08 rows=4 width=86) (actual time=0.679..0.682 rows=3 loops=1)
        One-Time Filter: app_private.has_channel_role('00000000-0000-4000-8000-000000000011'::uuid, '{owner,admin,operator,moderator,viewer}'::text[])
        Buffers: shared hit=140
        ->  WindowAgg  (cost=12.68..12.76 rows=4 width=57) (actual time=0.028..0.031 rows=3 loops=1)
              Buffers: shared hit=7
              ->  Sort  (cost=12.68..12.69 rows=4 width=49) (actual time=0.025..0.025 rows=3 loops=1)
                    Sort Key: module.enabled, module.created_at
                    Sort Method: quicksort  Memory: 25kB
                    Buffers: shared hit=7
                    ->  Bitmap Heap Scan on master_canvas_modules module  (cost=4.18..12.64 rows=4 width=49) (actual time=0.005..0.006 rows=3 loops=1)
                          Recheck Cond: (channel_id = '00000000-0000-4000-8000-000000000011'::uuid)
                          Heap Blocks: exact=1
                          Buffers: shared hit=2
                          ->  Bitmap Index Scan on master_canvas_modules_channel_idx  (cost=0.00..4.18 rows=4 width=0) (actual time=0.002..0.002 rows=3 loops=1)
                                Index Cond: (channel_id = '00000000-0000-4000-8000-000000000011'::uuid)
                                Buffers: shared hit=1
Planning:
  Buffers: shared hit=188
Planning Time: 0.534 ms
Execution Time: 1.036 ms
```
