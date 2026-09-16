# master-canvas-modules-overlay — EXPLAIN plan artifact (RT-12, closed by PRF-02 slice 2)

Function: `app_private.list_overlay_master_canvas_modules(uuid, text)`
Defined at: `packages/db/migrations/0131_v1_prf02_master_canvas_modules.sql:179` (block spans lines 179-208)

This is one of the two artifacts PRF-02 slice 2 was directed to capture (this task's §1(a)) —
`list_overlay_master_canvas_modules` was added by PRF-02 slice 1, is overlay-backing (the Master
Canvas runtime's `[overlayId]/page.tsx` reads it to decide which modules to mount — see
`master-canvas-sql-store.ts`), and had no EXPLAIN artefact, which is exactly the RT-12 blind spot
`tests/TC-RT-12-explain-plans.md`'s "Downgraded U → P" section describes.

## Exact query run

Seeded overlay session id: `00000000-0000-4000-8000-000000009999`
Seeded token fingerprint (sha256 hex of the fixed string `rt12-explain-capture-token-s2`): `e9966f41f78629475fa93f04272c64ee8d2269217afceccb205735c1e27b5595`

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM app_private.list_overlay_master_canvas_modules('00000000-0000-4000-8000-000000009999'::uuid, 'e9966f41f78629475fa93f04272c64ee8d2269217afceccb205735c1e27b5595');
```

query_hash: `10bbfd45bab6b1b9895a927e917440449ea77fb216cba67e24e212a1993ba052`

Computed by extracting the exact text from the `create or replace function app_private.list_overlay_master_canvas_modules(` line through the terminating `$$;` line (inclusive) out of `packages/db/migrations/0131_v1_prf02_master_canvas_modules.sql` as it exists at capture time, then `sha256sum`-ing that extracted text verbatim (UTF-8, including original newlines/whitespace). This is the identical extraction `packages/db/explain-plans/check-plans.mjs` re-runs against the migration file's CURRENT contents on every check; a hash mismatch means the function body changed since this artifact was captured and the plan needs re-verification.

captured_at: 2026-09-16T00:00:00Z
postgres_version: postgres:16-alpine (PostgreSQL 16.14 on aarch64-unknown-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit)

This EXPLAIN was captured against an unseeded/minimally-seeded local database (a handful of synthetic rows: three configured master_canvas_modules rows for one channel), not FULL-PRODUCT-DEFINITION.md §37.4's production-scale dataset (500 channels / 2,000,000 payments / 5,000,000 alert events / 200,000 supporter identities). It is a plan-shape change detector only — proof that the query still resolves to the same kind of plan (index scan vs. sequential scan) as when it was last captured — and it is NOT evidence that any §19.4 performance budget is met at production scale.

## Plan shape

Wrapper call: opaque `Function Scan on list_overlay_master_canvas_modules` (security definer, never inlined — see the correction below). Unwrapped body: fully resolved, no opaque sub-nodes — `Index Scan using overlay_sessions_pkey on overlay_sessions`, `Bitmap Heap Scan on channel_entitlement_versions` (via `channel_entitlement_versions_pkey`), `WindowAgg` over a `Sort` fed by `Bitmap Heap Scan on master_canvas_modules` (via `master_canvas_modules_channel_idx`) — every scan is an index or bitmap-index scan, no sequential scan anywhere in this plan at this seed size.

**Same correction the original ten RT-12 artifacts already record, reproduced here because this artifact stands alone**: `list_overlay_master_canvas_modules` is `language sql stable` AND `security definer`, and PostgreSQL's planner never inlines a SECURITY DEFINER SQL function regardless of STABLE/IMMUTABLE (`inline_function()` in `src/backend/optimizer/util/clauses.c`: `if (funcform->prosecdef) goto fail;` — inlining would run the body with the *caller's* privileges/search_path instead of the definer's). The literal wrapper-call EXPLAIN above therefore always shows an opaque `Function Scan`; the unwrapped body EXPLAIN below is what actually proves the scan-node shape.

## Raw EXPLAIN output — literal function-call query

```
Function Scan on list_overlay_master_canvas_modules  (cost=0.25..10.25 rows=1000 width=32) (actual time=2.727..2.727 rows=3 loops=1)
  Buffers: shared hit=800
Planning Time: 0.033 ms
Execution Time: 2.772 ms
```

## Raw EXPLAIN output — supplementary: function body unwrapped, parameters substituted with the same seeded literal values

This is the real plan for the SQL text covered by `query_hash` above (the function body, not the wrapper call).

```
Sort  (cost=31.03..31.04 rows=1 width=32) (actual time=0.173..0.175 rows=3 loops=1)
  Sort Key: ranked.module_key
  Sort Method: quicksort  Memory: 25kB
  Buffers: shared hit=18
  CTE session_channel
    ->  Index Scan using overlay_sessions_pkey on overlay_sessions session  (cost=0.15..8.18 rows=1 width=16) (actual time=0.006..0.006 rows=1 loops=1)
          Index Cond: (id = '00000000-0000-4000-8000-000000009999'::uuid)
          Filter: ((revoked_at IS NULL) AND (token_fingerprint = 'e9966f41f78629475fa93f04272c64ee8d2269217afceccb205735c1e27b5595'::text) AND (expires_at > CURRENT_TIMESTAMP))
          Buffers: shared hit=2
  CTE tiered
    ->  Limit  (cost=9.55..9.56 rows=1 width=40) (actual time=0.017..0.018 rows=1 loops=1)
          Buffers: shared hit=5
          ->  Sort  (cost=9.55..9.56 rows=2 width=40) (actual time=0.016..0.017 rows=1 loops=1)
                Sort Key: entitlement.version DESC
                Sort Method: quicksort  Memory: 25kB
                Buffers: shared hit=5
                ->  Nested Loop  (cost=4.16..9.54 rows=2 width=40) (actual time=0.004..0.005 rows=1 loops=1)
                      Buffers: shared hit=2
                      ->  CTE Scan on session_channel session_channel_1  (cost=0.00..0.02 rows=1 width=16) (actual time=0.000..0.000 rows=1 loops=1)
                      ->  Bitmap Heap Scan on channel_entitlement_versions entitlement  (cost=4.16..9.50 rows=2 width=56) (actual time=0.004..0.004 rows=1 loops=1)
                            Recheck Cond: (channel_id = session_channel_1.channel_id)
                            Heap Blocks: exact=1
                            Buffers: shared hit=2
                            ->  Bitmap Index Scan on channel_entitlement_versions_pkey  (cost=0.00..4.16 rows=2 width=0) (actual time=0.001..0.001 rows=1 loops=1)
                                  Index Cond: (channel_id = session_channel_1.channel_id)
                                  Buffers: shared hit=1
  InitPlan 3 (returns $3)
    ->  CTE Scan on tiered  (cost=0.00..0.27 rows=1 width=4) (actual time=0.113..0.114 rows=1 loops=1)
          Buffers: shared hit=8
  InitPlan 4 (returns $4)
    ->  CTE Scan on tiered tiered_1  (cost=0.00..0.27 rows=1 width=4) (never executed)
  ->  Subquery Scan on ranked  (cost=12.69..12.75 rows=1 width=32) (actual time=0.154..0.159 rows=3 loops=1)
        Filter: (($3 IS NULL) OR (ranked.rnk <= $4))
        Buffers: shared hit=15
        ->  WindowAgg  (cost=12.69..12.73 rows=2 width=48) (actual time=0.039..0.043 rows=3 loops=1)
              Buffers: shared hit=7
              ->  Sort  (cost=12.69..12.70 rows=2 width=40) (actual time=0.035..0.036 rows=3 loops=1)
                    Sort Key: module.created_at
                    Sort Method: quicksort  Memory: 25kB
                    Buffers: shared hit=7
                    ->  Nested Loop  (cost=4.18..12.68 rows=2 width=40) (actual time=0.015..0.016 rows=3 loops=1)
                          Buffers: shared hit=4
                          ->  CTE Scan on session_channel  (cost=0.00..0.02 rows=1 width=16) (actual time=0.007..0.007 rows=1 loops=1)
                                Buffers: shared hit=2
                          ->  Bitmap Heap Scan on master_canvas_modules module  (cost=4.18..12.64 rows=2 width=56) (actual time=0.006..0.007 rows=3 loops=1)
                                Recheck Cond: (channel_id = session_channel.channel_id)
                                Filter: enabled
                                Heap Blocks: exact=1
                                Buffers: shared hit=2
                                ->  Bitmap Index Scan on master_canvas_modules_channel_idx  (cost=0.00..4.18 rows=4 width=0) (actual time=0.004..0.004 rows=3 loops=1)
                                      Index Cond: (channel_id = session_channel.channel_id)
                                      Buffers: shared hit=1
Planning:
  Buffers: shared hit=309
Planning Time: 0.981 ms
Execution Time: 0.431 ms
```
