# widget-config — EXPLAIN plan artifact (RT-12, pre-existing gap closed by PRF-02 slice 2)

Function: `app_private.list_overlay_widget_config(uuid, text, text)`
Defined at: `packages/db/migrations/0105_v1_l16_interaction_definitions_and_widgets.sql:926` (block spans lines 926-945)

Like `lottie-assets.explain.md`, this artifact was NOT one of the two gaps PRF-02 slice 2's command
named explicitly — it was found by the general-purpose scan (`scan-required-queries.mjs`) while
closing those two, because this function also follows the `list_overlay_*` convention, is called from
`apps/api/src/db/interaction-sql-store.ts`, predates PRF-02 (migration 0105), and had no artefact.
See `required-queries.json`'s top-level comment and `reviews/2026-09-16-prf-02-slice-2-
implementation.md` for the full account of why both pre-existing gaps are closed here rather than
left.

## Exact query run

Seeded overlay session id: `00000000-0000-4000-8000-000000009999`
Seeded token fingerprint (sha256 hex of the fixed string `rt12-explain-capture-token-s2`): `e9966f41f78629475fa93f04272c64ee8d2269217afceccb205735c1e27b5595`
Widget type: `supporter_ticker` (a seeded, enabled, `privacy_scope = 'public'` `widget_configs` row).

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM app_private.list_overlay_widget_config('00000000-0000-4000-8000-000000009999'::uuid, 'e9966f41f78629475fa93f04272c64ee8d2269217afceccb205735c1e27b5595', 'supporter_ticker');
```

query_hash: `688c03a74a286fb32a7c120af146d353193edabea875e2e7611a60a01143a0f4`

Computed by extracting the exact text from the `create or replace function app_private.list_overlay_widget_config(` line through the terminating `$$;` line (inclusive) out of `packages/db/migrations/0105_v1_l16_interaction_definitions_and_widgets.sql` as it exists at capture time, then `sha256sum`-ing that extracted text verbatim (UTF-8, including original newlines/whitespace). This is the identical extraction `packages/db/explain-plans/check-plans.mjs` re-runs against the migration file's CURRENT contents on every check; a hash mismatch means the function body changed since this artifact was captured and the plan needs re-verification.

captured_at: 2026-09-16T00:00:00Z
postgres_version: postgres:16-alpine (PostgreSQL 16.14 on aarch64-unknown-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit)

This EXPLAIN was captured against an unseeded/minimally-seeded local database (one synthetic widget_configs row), not FULL-PRODUCT-DEFINITION.md §37.4's production-scale dataset. It is a plan-shape change detector only — proof that the query still resolves to the same kind of plan (index scan vs. sequential scan) as when it was last captured — and it is NOT evidence that any §19.4 performance budget is met at production scale.

## Plan shape

Wrapper call: opaque `Function Scan on list_overlay_widget_config` (security definer, never inlined — see the correction on every other artifact in this directory, reproduced in full on `master-canvas-modules-overlay.explain.md`). Unwrapped body: fully resolved, no opaque sub-nodes — `Index Scan using overlay_sessions_pkey`, `Index Scan using widget_configs_channel_idx`.

## Raw EXPLAIN output — literal function-call query

```
Function Scan on list_overlay_widget_config  (cost=0.25..10.25 rows=1000 width=144) (actual time=1.556..1.557 rows=1 loops=1)
  Buffers: shared hit=507
Planning Time: 0.035 ms
Execution Time: 1.581 ms
```

## Raw EXPLAIN output — supplementary: function body unwrapped, parameters substituted with the same seeded literal values

This is the real plan for the SQL text covered by `query_hash` above (the function body, not the wrapper call).

```
Limit  (cost=16.36..16.37 rows=1 width=152) (actual time=0.036..0.036 rows=1 loops=1)
  Buffers: shared hit=7
  ->  Sort  (cost=16.36..16.37 rows=1 width=152) (actual time=0.035..0.035 rows=1 loops=1)
        Sort Key: w.created_at DESC
        Sort Method: quicksort  Memory: 25kB
        Buffers: shared hit=7
        ->  Nested Loop  (cost=0.29..16.35 rows=1 width=152) (actual time=0.017..0.018 rows=1 loops=1)
              Buffers: shared hit=4
              ->  Index Scan using overlay_sessions_pkey on overlay_sessions session  (cost=0.15..8.18 rows=1 width=16) (actual time=0.007..0.007 rows=1 loops=1)
                    Index Cond: (id = '00000000-0000-4000-8000-000000009999'::uuid)
                    Filter: ((revoked_at IS NULL) AND (token_fingerprint = 'e9966f41f78629475fa93f04272c64ee8d2269217afceccb205735c1e27b5595'::text) AND (expires_at > CURRENT_TIMESTAMP))
                    Buffers: shared hit=2
              ->  Index Scan using widget_configs_channel_idx on widget_configs w  (cost=0.14..8.17 rows=1 width=168) (actual time=0.008..0.008 rows=1 loops=1)
                    Index Cond: (channel_id = session.channel_id)
                    Filter: ((widget_type = 'supporter_ticker'::text) AND (privacy_scope = 'public'::text))
                    Buffers: shared hit=2
Planning:
  Buffers: shared hit=241
Planning Time: 0.739 ms
Execution Time: 0.083 ms
```
