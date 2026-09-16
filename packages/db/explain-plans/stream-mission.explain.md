# stream-mission — EXPLAIN plan artifact (RT-12; §6 module #9, new in PRF-02 slice 5)

Function: `app_private.list_overlay_stream_mission(uuid, text)`
Defined at: `packages/db/migrations/0135_v1_prf02_slice5_stream_mission.sql:249` (block spans lines 249-269)

New function, new in this slice. Captured as part of this slice's own work rather than left for
a future one, per the "capture the artefact when the query is written" discipline RT-12
established and slice 2 carried forward.

This is the query behind the `/v1/overlay-widgets/:overlayId/stream-mission` browser-source read
that the Master Canvas's Stream Mission Card module paints. It is found by **all three** rules of
`scan-required-queries.mjs`, on substance rather than by avoiding any of them: rule 1 by the
`list_overlay_*` naming convention; rule 2 because its only call site,
`apps/api/src/db/stream-mission-overlay-store.ts`, has "overlay" in its basename; and rule 3
because `apps/api/src/index.ts` constructs `createSqlStreamMissionOverlayStore(derivedReadSql!)`,
so the composition-root scan resolves that factory through index.ts's own import statement and
scans its body. No exemption entry was added by this slice.

## Exact query run

Seeded overlay session id: `00000000-0000-4000-8000-000000009995`
Seeded token fingerprint (sha256 hex of the fixed string `rt12-explain-capture-token-s5`): `38b2e1e7533e65fac4897997c4d0a65c98969a561722e60a16b5484555565800`
Seeded data: base world channel `...0011` at tier `creator`, one running mission created through
`app_private.start_stream_mission` with the objective `Explain capture stream mission`, then
`ANALYZE`. Roles and the full migration set (`0001`–`0135`) were applied exactly as
`packages/db/tests/run-sql-suite.sh` applies them.

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM app_private.list_overlay_stream_mission('00000000-0000-4000-8000-000000009995'::uuid, '38b2e1e7533e65fac4897997c4d0a65c98969a561722e60a16b5484555565800');
```

query_hash: `8c9ab685ec36a6aca5554e034aea2aeeecebaa424277c60d4bd2dacc05ddbdef`

Computed by extracting the exact text from the `create or replace function app_private.list_overlay_stream_mission(` line through the terminating `$$;` line (inclusive) out of `packages/db/migrations/0135_v1_prf02_slice5_stream_mission.sql` as it exists at capture time, then `sha256`-ing that extracted text verbatim (UTF-8, including original newlines/whitespace). This is the identical extraction `packages/db/explain-plans/check-plans.mjs` re-runs against the migration file's CURRENT contents on every check; a hash mismatch means the function body changed since this artifact was captured and the plan needs re-verification.

captured_at: 2026-09-16T00:00:00Z
postgres_version: postgres:16-alpine (PostgreSQL 16.14 on aarch64-unknown-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit)

This EXPLAIN was captured against a minimally-seeded local database (one channel, one overlay
session, one running mission), **not** FULL-PRODUCT-DEFINITION.md §37.4's production-scale dataset
(500 channels / 2,000,000 payments / 5,000,000 alert events / 200,000 supporter identities). It is
a plan-**shape** change detector only — proof that the query still resolves to the same kind of
plan as when it was last captured — and it is **not** evidence that any §19.4 performance budget is
met at production scale, nor OBS/device/network evidence of any kind. §19.0's RT-07 (blocked)
remains the only row that can supply that.

## Plan shape, and an honest reading of it

Wrapper call: opaque `Function Scan on list_overlay_stream_mission` (security definer, never
inlined — the same correction every other artifact in this directory carries, reproduced in full on
`master-canvas-modules-overlay.explain.md`).

Unwrapped body: **two `Seq Scan`s** — one on `overlay_sessions`, one on `stream_missions` — joined
by a `Nested Loop`, then sorted and `Limit 1`. Both sequential scans are honest at this seed size
and are **not** evidence of production behaviour: each table holds a single row here, and PostgreSQL
will not choose an index scan over a one-page sequential scan whatever indexes exist. The same
disclosure the original `supporter-ticker.explain.md` / `paid-vote.explain.md` /
`tug-of-war-vote.explain.md` artifacts carry for their own small-table sequential scans applies
verbatim.

What the migration provides for the scaled case, stated here so the next capture has something to
compare against rather than a guess:

- `overlay_sessions` is looked up by primary key (`id`) plus a fingerprint/revocation/expiry filter
  — the identical access pattern every other `list_overlay_*` function uses, and the one those
  artifacts show resolving as `Index Scan using overlay_sessions_pkey` once the table is non-trivial.
- `stream_missions` is filtered by `channel_id` (through the join) and `ended_at is null`, which is
  exactly the partial unique index `stream_missions_channel_running_idx on (channel_id) where
  ended_at is null` — an index that can return **at most one row** by construction. The
  `order by ... limit 1` above it is therefore belt-and-braces, not the thing doing the bounding.

Whether the planner actually selects that partial index at scale is not demonstrated by this
capture and is not asserted. It is the specific thing a later, larger capture should check.

## Raw EXPLAIN output — literal function-call query

```
Function Scan on list_overlay_stream_mission  (cost=0.25..10.25 rows=1000 width=56) (actual time=1.146..1.146 rows=1 loops=1)
  Buffers: shared hit=521
Planning Time: 0.030 ms
Execution Time: 1.163 ms
```

## Raw EXPLAIN output — supplementary: function body unwrapped, parameters substituted with the same seeded literal values

This is the real plan for the SQL text covered by `query_hash` above (the function body, not the
wrapper call).

```
Limit  (cost=2.05..2.06 rows=1 width=55) (actual time=0.022..0.022 rows=1 loops=1)
  Buffers: shared hit=5
  ->  Sort  (cost=2.05..2.06 rows=1 width=55) (actual time=0.021..0.021 rows=1 loops=1)
        Sort Key: mission.started_at DESC
        Sort Method: quicksort  Memory: 25kB
        Buffers: shared hit=5
        ->  Nested Loop  (cost=0.00..2.04 rows=1 width=55) (actual time=0.005..0.006 rows=1 loops=1)
              Join Filter: (session.channel_id = mission.channel_id)
              Buffers: shared hit=2
              ->  Seq Scan on overlay_sessions session  (cost=0.00..1.02 rows=1 width=16) (actual time=0.003..0.003 rows=1 loops=1)
                    Filter: ((revoked_at IS NULL) AND (id = '00000000-0000-4000-8000-000000009995'::uuid) AND (token_fingerprint = '38b2e1e7533e65fac4897997c4d0a65c98969a561722e60a16b5484555565800'::text) AND (expires_at > CURRENT_TIMESTAMP))
                    Buffers: shared hit=1
              ->  Seq Scan on stream_missions mission  (cost=0.00..1.01 rows=1 width=71) (actual time=0.001..0.001 rows=1 loops=1)
                    Filter: (ended_at IS NULL)
                    Buffers: shared hit=1
Planning:
  Buffers: shared hit=256
Planning Time: 0.525 ms
Execution Time: 0.042 ms
```
