# moderator-status — EXPLAIN plan artifact (RT-12; §6 module #12, held count + safe mode)

Function: `app_private.list_overlay_moderator_status(uuid, text)`
Defined at: `packages/db/migrations/0138_v1_prf02_safe_mode.sql:941` (block spans lines 941-971)

**Re-captured 2026-09-16** against migration `0138`, which completes §6 module #12 by adding the
creator's safe-mode flag to this read. The function is `drop`ped and re-created rather than
replaced, because PostgreSQL cannot change a function's OUT columns with `create or replace` — the
same mechanic `0127` used for `get_overlay_events`. The previous capture (slice 5, migration `0136`,
one `held_count` column) is superseded by this one; the held-count half of the plan is unchanged and
the whole difference is `SubPlan 2` below.

## Exact query run

Seeded overlay session id: `00000000-0000-4000-8000-000000009998`
Seeded token fingerprint (sha256 hex of the fixed string `rt12-explain-capture-token-s5`): `38b2e1e7533e65fac4897997c4d0a65c98969a561722e60a16b5484555565800`
Seeded data: one channel **with safe mode ON**, one open alert queue, twelve alert deliveries on that
queue — **four `held`** and eight `displayed` — so the plan is captured against a predicate that
actually filters rather than one that matches every row, and against a safe-mode subquery that
returns `true` rather than one the planner could shortcut. `ANALYZE` was run before capture.

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM app_private.list_overlay_moderator_status('00000000-0000-4000-8000-000000009998'::uuid, '38b2e1e7533e65fac4897997c4d0a65c98969a561722e60a16b5484555565800');
```

The call returns exactly one row reading `held_count = 4`, `safe_mode = t`. **One integer and one
boolean. That is the whole projection** — §6's "never private content" is a property of this query
rather than of the renderer, and `packages/db/tests/prf02_slice5_moderator_status.sql` asserts the
returned column set directly (case S5.4, extended from slice 5's one-column assertion to
`TABLE(held_count bigint, safe_mode boolean)` rather than deleted; a third column of any name still
fails it).

query_hash: `bd90f14e652cd2c6a9aca6347566f80816f737526ca75ede4d63a1b885d80fc7`

Computed by extracting the exact text from the `create function app_private.list_overlay_moderator_status(` line through the terminating `$$;` line (inclusive) out of `packages/db/migrations/0138_v1_prf02_safe_mode.sql` as it exists at capture time, then `sha256sum`-ing that extracted text verbatim (UTF-8, including original newlines/whitespace). This is the identical extraction `packages/db/explain-plans/check-plans.mjs` re-runs against the migration file's CURRENT contents on every check; a hash mismatch means the function body changed since this artifact was captured and the plan needs re-verification.

captured_at: 2026-09-16T00:00:00Z
postgres_version: postgres:16-alpine (PostgreSQL 16.14 on aarch64-unknown-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit)

This EXPLAIN was captured against a minimally-seeded local database (one channel, one queue, twelve
deliveries), **not** FULL-PRODUCT-DEFINITION.md §37.4's production-scale dataset (500 channels /
2,000,000 payments / 5,000,000 alert events / 200,000 supporter identities). It is a plan-shape
change detector only — proof that the query still resolves to the same kind of plan as when it was
last captured — and it is **NOT** evidence that any §19.4 performance budget is met at production
scale, nor any form of production, provider, device, network or release readiness. §19.0's RT-07
remains Blocked and is the only row that can supply OBS/Chromium/device/soak evidence.

## Plan shape

Wrapper call: opaque `Function Scan on list_overlay_moderator_status` (security definer, never
inlined — the same correction every other artifact in this directory carries, reproduced in full on
`master-canvas-modules-overlay.explain.md`). Unwrapped body: the `overlay_sessions` gate is the outer
scan, the held count is `SubPlan 1` (an `Aggregate` over a nested loop of `alert_queues` ⋈
`event_outbox_deliveries`) and **the safe-mode read is `SubPlan 2`, a single-row lookup on
`public.channels`.**

**What safe mode added to this plan, precisely:** one `SubPlan 2` — a `Seq Scan on channels` with
`Filter: (id = session.channel_id)`, one buffer, `rows=1`, `actual time=0.001..0.001`. No join was
added to the outer query, the held-count subplan is byte-identical in shape to the slice-5 capture,
and the row estimate at the top is unchanged. At this seed size `channels` holds a handful of rows
so the planner declines `channels_pkey`; at any realistic size the filter is an equality on the
primary key and the lookup is an index scan. The flag costs one primary-key row read, which is why
it went on the channel row rather than into its own table (recorded as D1 in
`bharatstudio-requirements/active/tasks/PRF-02-safe-mode.md`).

**Both leaf scans of the count are sequential at this seed size, and both are honest rather than
surprising:**

- **`Seq Scan on event_outbox_deliveries`** with `Filter: (status = 'held')`, `Rows Removed by
  Filter: 8`. The partial index `0136` added —
  `event_outbox_deliveries_held_by_queue_idx on (queue_id) where status = 'held'` — **exists in the
  captured database** (confirmed in the capture run's own `pg_indexes` listing, reproduced below) and
  the planner simply declines it on a twelve-row table, where a sequential scan costs less than an
  index descent. That is the correct choice at this size and says nothing either way about the
  choice at scale. `0138` adds no index of its own and removes none.
- **`Seq Scan on alert_queues`** with `Filter: (channel_id = session.channel_id)`. **`alert_queues`
  has no index on `channel_id` at all today** — not one this work removed, one that has never
  existed. Still deliberately not added: `alert_queues` is a shared table and an index on it would
  change plan shapes for queries this work does not own. Whether `alert_queues(channel_id)` is
  warranted remains a real open question for whoever can measure a realistic per-channel queue count,
  and it stays recorded as referred work rather than patched speculatively.
- **`Seq Scan on overlay_sessions`** likewise, on a one-row table; `overlay_sessions_pkey` exists and
  is used by the same gate in other artefacts (see `tug-of-war-vote.explain.md`) once the table holds
  more than a handful of rows.

## Raw EXPLAIN output — literal function-call query

```
Function Scan on list_overlay_moderator_status  (cost=0.25..10.25 rows=1000 width=9) (actual time=1.597..1.597 rows=1 loops=1)
  Buffers: shared hit=634
Planning Time: 0.028 ms
Execution Time: 1.630 ms
```

## Raw EXPLAIN output — supplementary: function body unwrapped, parameters substituted with the same seeded literal values

This is the real plan for the SQL text covered by `query_hash` above (the function body, not the
wrapper call).

```
Seq Scan on overlay_sessions session  (cost=0.00..4.26 rows=1 width=9) (actual time=0.015..0.016 rows=1 loops=1)
  Filter: ((revoked_at IS NULL) AND (id = '00000000-0000-4000-8000-000000009998'::uuid) AND (token_fingerprint = '38b2e1e7533e65fac4897997c4d0a65c98969a561722e60a16b5484555565800'::text) AND (expires_at > CURRENT_TIMESTAMP))
  Buffers: shared hit=4
  SubPlan 1
    ->  Aggregate  (cost=2.22..2.23 rows=1 width=8) (actual time=0.008..0.008 rows=1 loops=1)
          Buffers: shared hit=2
          ->  Nested Loop  (cost=0.00..2.21 rows=4 width=0) (actual time=0.005..0.007 rows=4 loops=1)
                Join Filter: (queue.id = delivery.queue_id)
                Buffers: shared hit=2
                ->  Seq Scan on alert_queues queue  (cost=0.00..1.01 rows=1 width=16) (actual time=0.001..0.001 rows=1 loops=1)
                      Filter: (channel_id = session.channel_id)
                      Buffers: shared hit=1
                ->  Seq Scan on event_outbox_deliveries delivery  (cost=0.00..1.15 rows=4 width=16) (actual time=0.004..0.005 rows=4 loops=1)
                      Filter: (status = 'held'::text)
                      Rows Removed by Filter: 8
                      Buffers: shared hit=1
  SubPlan 2
    ->  Seq Scan on channels channel  (cost=0.00..1.01 rows=1 width=1) (actual time=0.001..0.001 rows=1 loops=1)
          Filter: (id = session.channel_id)
          Buffers: shared hit=1
Planning:
  Buffers: shared hit=1
Planning Time: 0.088 ms
Execution Time: 0.034 ms
```

## Returned row, reproduced

```
 held_count | safe_mode
------------+-----------
          4 | t
```

## Indexes present on `event_outbox_deliveries` in the captured database

Recorded because the claim "the partial index exists, the planner merely declined it at this size"
is otherwise unverifiable from the plan alone. `0138` adds none and removes none, so this listing is
identical to the slice-5 capture's.

```
event_outbox_deliveries_claim_idx
event_outbox_deliveries_held_by_queue_idx
event_outbox_deliveries_outbox_id_queue_id_key
event_outbox_deliveries_pkey
event_outbox_deliveries_unpublished_ready_idx
```
