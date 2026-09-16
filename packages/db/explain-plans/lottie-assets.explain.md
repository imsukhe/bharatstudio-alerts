# lottie-assets — EXPLAIN plan artifact (RT-12, pre-existing gap closed by PRF-02 slice 2)

Function: `app_private.list_overlay_lottie_assets(uuid, text)`
Defined at: `packages/db/migrations/0077_v1_l03_lottie_branding_upload.sql:171` (block spans lines 171-194)

This artifact was NOT one of the two gaps PRF-02 slice 2's command named explicitly. It was found by
the general-purpose scan (`scan-required-queries.mjs`) built to close the two named gaps: this
function follows the same `list_overlay_*` overlay-facing widget-read convention as the original ten
RT-12 artifacts, is called from `apps/api/src/db/overlay-branding-store.ts`, predates PRF-02 entirely
(migration 0077), and had no artefact. A scan that only checked for the two functions already known
about would repeat RT-12's own failure pattern one level up, so this gap is closed alongside the two
named ones rather than left for a future slice to re-discover. See `required-queries.json`'s top-level
comment and `reviews/2026-09-16-prf-02-slice-2-implementation.md` for the full account.

## Exact query run

Seeded overlay session id: `00000000-0000-4000-8000-000000009999`
Seeded token fingerprint (sha256 hex of the fixed string `rt12-explain-capture-token-s2`): `e9966f41f78629475fa93f04272c64ee8d2269217afceccb205735c1e27b5595`
Seeded channel tier: `studio` (the only tier `app_private.tier_custom_branding_allowed` returns true for — a `creator`-tier capture would correctly return zero rows, which would not exercise the join at all).

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM app_private.list_overlay_lottie_assets('00000000-0000-4000-8000-000000009999'::uuid, 'e9966f41f78629475fa93f04272c64ee8d2269217afceccb205735c1e27b5595');
```

query_hash: `25016017e1e5365d4ca7643c0592e504ea3fd2cd57108818913321d1a2e7f77f`

Computed by extracting the exact text from the `create or replace function app_private.list_overlay_lottie_assets(` line through the terminating `$$;` line (inclusive) out of `packages/db/migrations/0077_v1_l03_lottie_branding_upload.sql` as it exists at capture time, then `sha256sum`-ing that extracted text verbatim (UTF-8, including original newlines/whitespace). This is the identical extraction `packages/db/explain-plans/check-plans.mjs` re-runs against the migration file's CURRENT contents on every check; a hash mismatch means the function body changed since this artifact was captured and the plan needs re-verification.

captured_at: 2026-09-16T00:00:00Z
postgres_version: postgres:16-alpine (PostgreSQL 16.14 on aarch64-unknown-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit)

This EXPLAIN was captured against an unseeded/minimally-seeded local database (one synthetic lottie asset row), not FULL-PRODUCT-DEFINITION.md §37.4's production-scale dataset. It is a plan-shape change detector only — proof that the query still resolves to the same kind of plan (index scan vs. sequential scan) as when it was last captured — and it is NOT evidence that any §19.4 performance budget is met at production scale.

## Plan shape

Wrapper call: opaque `Function Scan on list_overlay_lottie_assets` (security definer, never inlined — see the correction on every other artifact in this directory, reproduced in full on `master-canvas-modules-overlay.explain.md`). Unwrapped body: fully resolved, no opaque sub-nodes — `Index Scan using overlay_sessions_pkey`, `Index Scan using channel_entitlement_versions_pkey` (with a correlated `SubPlan` resolving `max(version)` via `Index Only Scan Backward`), `Index Scan using channel_lottie_assets_channel_id_display_style_key`.

## Raw EXPLAIN output — literal function-call query

```
Function Scan on list_overlay_lottie_assets  (cost=0.25..10.25 rows=1000 width=48) (actual time=1.995..1.995 rows=1 loops=1)
  Buffers: shared hit=591
Planning Time: 0.031 ms
Execution Time: 2.028 ms
```

## Raw EXPLAIN output — supplementary: function body unwrapped, parameters substituted with the same seeded literal values

This is the real plan for the SQL text covered by `query_hash` above (the function body, not the wrapper call).

```
Nested Loop  (cost=6.62..23.37 rows=2 width=48) (actual time=0.164..0.166 rows=1 loops=1)
  Buffers: shared hit=14
  ->  Nested Loop  (cost=6.47..22.87 rows=1 width=32) (actual time=0.158..0.160 rows=1 loops=1)
        Buffers: shared hit=12
        ->  Index Scan using overlay_sessions_pkey on overlay_sessions session  (cost=0.15..8.18 rows=1 width=16) (actual time=0.008..0.008 rows=1 loops=1)
              Index Cond: (id = '00000000-0000-4000-8000-000000009999'::uuid)
              Filter: ((revoked_at IS NULL) AND (token_fingerprint = 'e9966f41f78629475fa93f04272c64ee8d2269217afceccb205735c1e27b5595'::text) AND (expires_at > CURRENT_TIMESTAMP))
              Buffers: shared hit=2
        ->  Index Scan using channel_entitlement_versions_pkey on channel_entitlement_versions entitlement  (cost=6.32..14.59 rows=1 width=24) (actual time=0.134..0.135 rows=1 loops=1)
              Index Cond: ((channel_id = session.channel_id) AND (version = (SubPlan 2)))
              Filter: app_private.tier_custom_branding_allowed(tier)
              Buffers: shared hit=8
              SubPlan 2
                ->  Result  (cost=6.17..6.18 rows=1 width=8) (actual time=0.013..0.014 rows=1 loops=1)
                      Buffers: shared hit=2
                      InitPlan 1 (returns $1)
                        ->  Limit  (cost=0.15..6.17 rows=1 width=8) (actual time=0.012..0.012 rows=1 loops=1)
                              Buffers: shared hit=2
                              ->  Index Only Scan Backward using channel_entitlement_versions_pkey on channel_entitlement_versions  (cost=0.15..12.19 rows=2 width=8) (actual time=0.011..0.011 rows=1 loops=1)
                                    Index Cond: ((channel_id = session.channel_id) AND (version IS NOT NULL))
                                    Heap Fetches: 1
                                    Buffers: shared hit=2
  ->  Index Scan using channel_lottie_assets_channel_id_display_style_key on channel_lottie_assets asset  (cost=0.15..0.48 rows=2 width=64) (actual time=0.005..0.005 rows=1 loops=1)
        Index Cond: (channel_id = entitlement.channel_id)
        Buffers: shared hit=2
Planning:
  Buffers: shared hit=369
Planning Time: 1.066 ms
Execution Time: 0.409 ms
```
