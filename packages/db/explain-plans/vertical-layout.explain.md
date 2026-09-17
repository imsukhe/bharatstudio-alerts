# vertical-layout — EXPLAIN plan artifact (RT-12; §6 module #14, Vertical Stream Layout)

Function: `app_private.list_overlay_canvas_layout(uuid, text)`
Defined at: `packages/db/migrations/0147_v1_prf02_vertical_layout.sql:306` (block spans lines 306-328)

## Exact query run

Seeded overlay session id: `00000000-0000-4000-8000-000000009997`
Seeded token fingerprint (sha256 hex of the fixed string `rt12-explain-capture-token-s7vl`): `344b47aba1377edc8da27eb934c478cd32c74438886fd8c3979c363e752455f3`
Seeded data: one Pro-tier channel with `canvas_layout = 'vertical'` and one valid overlay session. `ANALYZE` was run before capture.

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM app_private.list_overlay_canvas_layout('00000000-0000-4000-8000-000000009997'::uuid, '344b47aba1377edc8da27eb934c478cd32c74438886fd8c3979c363e752455f3');
```

The call returns exactly one row: `layout = 'vertical'`. **One text column. That is the whole projection** — no channel id, no entitlement flag, no timestamp — asserted by `packages/db/tests/prf02_slice7_vertical_layout.sql` directly against `information_schema.parameters` (`layout`, nothing else).

BECAUSE THE SEEDED CHANNEL IS PRO-TIER, this capture exercises the `'vertical'` branch of the function's own `case` expression — the §30.3 Pro+ gate (`app_private.vertical_canvas_layout_entitled`) evaluates true inside the query itself, not in this artifact's SQL. A sub-Pro channel with the identical `canvas_layout = 'vertical'` row takes the `else 'horizontal'` branch instead — same plan shape, different returned value; `packages/db/tests/prf02_slice7_vertical_layout.sql` proves that behaviour directly (the sub-Pro proof named in this task), not this artifact.

query_hash: `b2fef145b9d55b6b0237b1a36ef4d7e0972c6bba75a30fb8d850eb581c7553b1`

Computed by extracting the exact text from the `create or replace function app_private.list_overlay_canvas_layout(` line through the terminating `$$;` line (inclusive) out of `packages/db/migrations/0147_v1_prf02_vertical_layout.sql` as it exists at capture time, then `sha256sum`-ing that extracted text verbatim (UTF-8, including original newlines/whitespace). This is the identical extraction `packages/db/explain-plans/check-plans.mjs` re-runs against the migration file's CURRENT contents on every check; a hash mismatch means the function body changed since this artifact was captured and the plan needs re-verification.

captured_at: 2026-09-17T00:00:00Z
postgres_version: postgres:16-alpine (PostgreSQL 16.14 on aarch64-unknown-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit)

This EXPLAIN was captured against a minimally-seeded local database (one channel, one overlay session), **not** FULL-PRODUCT-DEFINITION.md §37.4's production-scale dataset (500 channels / 2,000,000 payments / 5,000,000 alert events / 200,000 supporter identities). It is a plan-shape change detector only — proof that the query still resolves to the same kind of plan as when it was last captured — and it is **NOT** evidence that any §19.4 performance budget is met at production scale, nor any form of production, provider, device, network or release readiness. §19.0's RT-07 remains Blocked and is the only row that can supply OBS/Chromium/device/soak evidence.

## Plan shape

Wrapper call: opaque `Function Scan on list_overlay_canvas_layout` (security definer, never inlined — the same correction every other artifact in this directory carries; see `qr-smart-card.explain.md`'s own note for the general shape). Unwrapped body: a `Nested Loop` joining `overlay_sessions` (the session/token-fingerprint/revocation/expiry gate) to `channels` (the `canvas_layout` value and the `vertical_canvas_layout_entitled` check) on `channel_id`.

**Both leaf scans are sequential at this seed size, and both are honest rather than surprising:**

- **`Seq Scan on overlay_sessions`**, `Filter: ((revoked_at IS NULL) AND (id = ...) AND (token_fingerprint = ...) AND (expires_at > CURRENT_TIMESTAMP))`. `overlay_sessions_pkey` exists (confirmed in the capture run's own index listing, reproduced below) and the planner declines it on a one-row table, exactly as every other overlay-read artifact in this directory records at this seed size.
- **`Seq Scan on channels`**, no residual filter in the unwrapped plan (the `canvas_layout`/entitlement comparison happens in the `select` list's `case` expression, evaluated per row rather than as a scan filter). `channels_pkey` exists (confirmed below) and is declined by the planner at this seed size for the same reason every other single-row lookup in this directory is: the join already narrows to at most one row via `channel_id`, so an index lookup buys nothing over a one-row sequential scan.

The join itself (`Join Filter: (session.channel_id = channel.id)`) resolves to a `Nested Loop` over the two one-row scans rather than a hash or merge join, which is the correct choice for the row counts involved and says nothing either way about plan shape at scale. `app_private.vertical_canvas_layout_entitled` itself is a further security-definer function call inside the `case` expression (calling `app_private.current_channel_tier`, a simple order-by-version-desc-limit-1 lookup on `channel_entitlement_versions`); at this seed size (one entitlement version row) it resolves in negligible time and does not appear as a separate scan node in the unwrapped EXPLAIN because both are scalar SQL functions the planner inlines into the expression, not a joined relation.

## Raw EXPLAIN output — literal function-call query

```
Function Scan on list_overlay_canvas_layout  (cost=0.25..10.25 rows=1000 width=32) (actual time=1.953..1.954 rows=1 loops=1)
  Buffers: shared hit=620
Planning Time: 0.032 ms
Execution Time: 1.977 ms
```

## Raw EXPLAIN output — supplementary: function body unwrapped, parameters substituted with the same seeded literal values

This is the real plan for the SQL text covered by `query_hash` above (the function body, not the wrapper call).

```
Nested Loop  (cost=0.00..2.30 rows=1 width=32) (actual time=0.950..0.951 rows=1 loops=1)
  Join Filter: (session.channel_id = channel.id)
  Buffers: shared hit=189
  ->  Seq Scan on overlay_sessions session  (cost=0.00..1.02 rows=1 width=16) (actual time=0.005..0.005 rows=1 loops=1)
        Filter: ((revoked_at IS NULL) AND (id = '00000000-0000-4000-8000-000000009997'::uuid) AND (token_fingerprint = '344b47aba1377edc8da27eb934c478cd32c74438886fd8c3979c363e752455f3'::text) AND (expires_at > CURRENT_TIMESTAMP))
        Buffers: shared hit=1
  ->  Seq Scan on channels channel  (cost=0.00..1.01 rows=1 width=25) (actual time=0.004..0.004 rows=1 loops=1)
        Buffers: shared hit=1
Planning:
  Buffers: shared hit=259
Planning Time: 0.673 ms
Execution Time: 0.974 ms
```

## Returned row, reproduced

```
  layout  
----------
 vertical
```

## Indexes present on `channels` and `overlay_sessions` in the captured database

Recorded because the claim "the primary key exists, the planner merely declined it at this size" is otherwise unverifiable from the plan alone.

```
overlay_sessions_pkey   -- primary key, btree (id)
channels_pkey           -- primary key, btree (id)
```
