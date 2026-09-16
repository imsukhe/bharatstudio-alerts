# moderator-status — EXPLAIN plan artifact (RT-12; §6 module #12, held half only, new in PRF-02 slice 5)

Function: `app_private.list_overlay_moderator_status(uuid, text)`
Defined at: `packages/db/migrations/0136_v1_prf02_slice5_moderator_status.sql:95` (block spans lines 95-117)

New function, new in this slice, and the only server-side cost of §6 module #12's held half.
Captured as part of this slice's own work rather than left for a later one, per the same
"capture the artefact when the query is written" discipline RT-12's closure established.

## Exact query run

Seeded overlay session id: `00000000-0000-4000-8000-000000009998`
Seeded token fingerprint (sha256 hex of the fixed string `rt12-explain-capture-token-s5`): `38b2e1e7533e65fac4897997c4d0a65c98969a561722e60a16b5484555565800`
Seeded data: one channel, one open alert queue, twelve alert deliveries on that queue — **four
`held`** and eight `displayed` — so the plan is captured against a predicate that actually filters
rather than one that matches every row. `ANALYZE` was run before capture.

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM app_private.list_overlay_moderator_status('00000000-0000-4000-8000-000000009998'::uuid, '38b2e1e7533e65fac4897997c4d0a65c98969a561722e60a16b5484555565800');
```

The call returns exactly one row reading `held_count = 4`. **One column. That is the whole
projection** — §6's "never private content" is a property of this query rather than of the
renderer, and `packages/db/tests/prf02_slice5_moderator_status.sql` asserts the returned column set
directly (from `pg_get_function_result` and from a table materialised out of a live call).

query_hash: `57e0823031660513716a740822a6e278b93b3876d168502d5e3002214e0f0526`

Computed by extracting the exact text from the `create or replace function app_private.list_overlay_moderator_status(` line through the terminating `$$;` line (inclusive) out of `packages/db/migrations/0136_v1_prf02_slice5_moderator_status.sql` as it exists at capture time, then `sha256sum`-ing that extracted text verbatim (UTF-8, including original newlines/whitespace). This is the identical extraction `packages/db/explain-plans/check-plans.mjs` re-runs against the migration file's CURRENT contents on every check; a hash mismatch means the function body changed since this artifact was captured and the plan needs re-verification.

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
scan and the count is `SubPlan 1`, a single `Aggregate` over a nested loop of `alert_queues` ⋈
`event_outbox_deliveries`.

**Both leaf scans are sequential at this seed size, and both are honest rather than surprising:**

- **`Seq Scan on event_outbox_deliveries`** with `Filter: (status = 'held')`, `Rows Removed by
  Filter: 8`. The partial index this migration adds —
  `event_outbox_deliveries_held_by_queue_idx on (queue_id) where status = 'held'` — **exists in the
  captured database** (confirmed in the capture run's own `pg_indexes` listing, reproduced below) and
  the planner simply declines it on a twelve-row table, where a sequential scan costs less than an
  index descent. That is the correct choice at this size and says nothing either way about the
  choice at scale. What the artefact establishes is that the index is present and that the predicate
  it was built for is the predicate the plan actually carries.
- **`Seq Scan on alert_queues`** with `Filter: (channel_id = session.channel_id)`. **`alert_queues`
  has no index on `channel_id` at all today** — not one this slice removed, one that has never
  existed. This slice deliberately did not add it: `alert_queues` is a shared table and an index on
  it would change plan shapes for queries this slice does not own. Whether `alert_queues(channel_id)`
  is warranted is a real open question for whoever can measure a realistic per-channel queue count,
  and it is recorded as referred work in
  `bharatstudio-requirements/active/tasks/PRF-02.md`'s "Slice 5" section rather than patched
  speculatively here.
- **`Seq Scan on overlay_sessions`** likewise, on a one-row table; `overlay_sessions_pkey` exists and
  is used by the same gate in other artefacts (see `tug-of-war-vote.explain.md`) once the table holds
  more than a handful of rows.

## Raw EXPLAIN output — literal function-call query

```
Function Scan on list_overlay_moderator_status  (cost=0.25..10.25 rows=1000 width=8) (actual time=1.323..1.323 rows=1 loops=1)
  Buffers: shared hit=555
Planning Time: 0.029 ms
Execution Time: 1.357 ms
```

## Raw EXPLAIN output — supplementary: function body unwrapped, parameters substituted with the same seeded literal values

This is the real plan for the SQL text covered by `query_hash` above (the function body, not the
wrapper call).

```
Seq Scan on overlay_sessions session  (cost=0.00..3.25 rows=1 width=8) (actual time=0.007..0.007 rows=1 loops=1)
  Filter: ((revoked_at IS NULL) AND (id = '00000000-0000-4000-8000-000000009998'::uuid) AND (token_fingerprint = '38b2e1e7533e65fac4897997c4d0a65c98969a561722e60a16b5484555565800'::text) AND (expires_at > CURRENT_TIMESTAMP))
  Buffers: shared hit=3
  SubPlan 1
    ->  Aggregate  (cost=2.22..2.23 rows=1 width=8) (actual time=0.004..0.004 rows=1 loops=1)
          Buffers: shared hit=2
          ->  Nested Loop  (cost=0.00..2.21 rows=4 width=0) (actual time=0.002..0.003 rows=4 loops=1)
                Join Filter: (queue.id = delivery.queue_id)
                Buffers: shared hit=2
                ->  Seq Scan on alert_queues queue  (cost=0.00..1.01 rows=1 width=16) (actual time=0.001..0.001 rows=1 loops=1)
                      Filter: (channel_id = session.channel_id)
                      Buffers: shared hit=1
                ->  Seq Scan on event_outbox_deliveries delivery  (cost=0.00..1.15 rows=4 width=16) (actual time=0.001..0.001 rows=4 loops=1)
                      Filter: (status = 'held'::text)
                      Rows Removed by Filter: 8
                      Buffers: shared hit=1
Planning Time: 0.057 ms
Execution Time: 0.017 ms
```

## Indexes present on `event_outbox_deliveries` in the captured database

Recorded because the claim "the partial index exists, the planner merely declined it at this size"
is otherwise unverifiable from the plan alone.

```
event_outbox_deliveries_claim_idx
event_outbox_deliveries_held_by_queue_idx
event_outbox_deliveries_outbox_id_queue_id_key
event_outbox_deliveries_pkey
event_outbox_deliveries_unpublished_ready_idx
```
