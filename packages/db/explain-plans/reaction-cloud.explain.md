# reaction-cloud — EXPLAIN plan artifact (RT-12; §6 module #5, new in PRF-02 slice 6 / PRF-06)

Function: `app_private.list_overlay_reaction_cloud(uuid, text, integer)`
Defined at: `packages/db/migrations/0139_v1_prf02_prf06_reaction_sampling.sql:388` (block spans lines 388-436)

New function, new in this slice, and the whole server-side read cost of §6 module #5. Captured
as part of this slice's own work rather than left for a later one, per the "capture the artefact
when the query is written" discipline RT-12's closure established.

**The write path — `app_private.record_channel_reaction` — has no artefact here, deliberately.**
It is an insert under a row lock on the main pool, not a widget-backing derived read, so none of
`scan-required-queries.mjs`'s three rules requires one and a plan-shape artefact of it would be
documenting something RT-12's manifest is not about. It is asserted behaviourally instead, in
`packages/db/tests/prf02_slice6_reaction_cloud.sql`.

## Exact query run

Seeded overlay session id: `00000000-0000-4000-8000-000000009941`
Seeded token fingerprint: `ab5f4cf2f9c6e6b2d4b8a0a1f3c5e7d9b1a3c5e7f9b1d3f5a7c9e1b3d5f7a9c1`
Seeded data: two channels, four platform catalogue entries, one staff-reviewed creator pack, and
**810 reaction rows** — 400 in-window catalogue sends and 60 in-window creator-pack sends on the
channel under test, **200 aged-out sends on the same channel**, and **150 on a second channel the
read must never see**. Both of the last two groups exist so the window predicate and the channel
predicate are each captured filtering rather than matching everything. `ANALYZE` was run before
capture.

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM app_private.list_overlay_reaction_cloud('00000000-0000-4000-8000-000000009941'::uuid, 'ab5f4cf2f9c6e6b2d4b8a0a1f3c5e7d9b1a3c5e7f9b1d3f5a7c9e1b3d5f7a9c1', null);
```

The call returns **five rows** — one per distinct catalogue entry with reactions in the window —
out of 810 stored rows:

```
 entry_source |               entry_id               | display_name | reaction_count
--------------+--------------------------------------+--------------+----------------
 catalogue    | 00000000-0000-4000-8000-000000009921 | Clap         |            100
 catalogue    | 00000000-0000-4000-8000-000000009922 | Fire         |            100
 catalogue    | 00000000-0000-4000-8000-000000009923 | Heart        |            100
 catalogue    | 00000000-0000-4000-8000-000000009924 | Star         |            100
 creator_pack | 00000000-0000-4000-8000-000000009931 | Pack Star    |             60
```

**Four columns. That is the whole projection** — §6 #5's "non-identifying" is a property of this
query rather than of the renderer, and `packages/db/tests/prf02_slice6_reaction_cloud.sql` asserts
the returned column set directly (from `pg_get_function_result` and from a table materialised out
of a live call). No viewer id, no anonymous identity token, no session id, no IP, and no timestamp
is in it.

### The sampling is server-side, and this is the evidence

The same call with a ceiling of 2 returns **two rows, not five**, from the same 810 stored rows:

```sql
SELECT * FROM app_private.list_overlay_reaction_cloud('00000000-0000-4000-8000-000000009941'::uuid, 'ab5f4cf2f9c6e6b2d4b8a0a1f3c5e7d9b1a3c5e7f9b1d3f5a7c9e1b3d5f7a9c1', 2);
```

```
 entry_source |               entry_id               | display_name | reaction_count
--------------+--------------------------------------+--------------+----------------
 catalogue    | 00000000-0000-4000-8000-000000009921 | Clap         |            100
 catalogue    | 00000000-0000-4000-8000-000000009922 | Fire         |            100
```

810 rows in the table, 460 of them in-window, **five rows out with the ceiling unset and two with
it set to 2**. The client is never sent the stream and told to drop some (§19.5) — the aggregate
happens before the ceiling, and both happen inside the security-definer function.

The ceiling ships **unset** (`null` → `LIMIT NULL` → no limit), which is the "configured but
unset" posture: shipping it unset changes nothing, shipping it set changes exactly one thing.

query_hash: `b8d58671d0559da00418427be6fecf85e1a087e459ecf2b644f48414e59beb62`

Computed by extracting the exact text from the `create or replace function app_private.list_overlay_reaction_cloud(` line through the terminating `$$;` line (inclusive) out of `packages/db/migrations/0139_v1_prf02_prf06_reaction_sampling.sql` as it exists at capture time, then `sha256sum`-ing that extracted text verbatim (UTF-8, including original newlines/whitespace). This is the identical extraction `packages/db/explain-plans/check-plans.mjs` re-runs against the migration file's CURRENT contents on every check; a hash mismatch means the function body changed since this artifact was captured and the plan needs re-verification.

captured_at: 2026-09-16T00:00:00Z
postgres_version: postgres:16-alpine (PostgreSQL 16.14 on aarch64-unknown-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit)

This EXPLAIN was captured against a minimally-seeded local database (two channels, five catalogue
entries, 810 reaction rows), **not** FULL-PRODUCT-DEFINITION.md §37.4's production-scale dataset
(500 channels / 2,000,000 payments / 5,000,000 alert events / 200,000 supporter identities). It is
a plan-shape change detector only — proof that the query still resolves to the same kind of plan as
when it was last captured — and it is **NOT** evidence that any §19.4 performance budget is met at
production scale, nor any form of production, provider, device, network or release readiness.
§19.0's RT-07 remains Blocked and is the only row that can supply OBS/Chromium/device/soak
evidence.

## Plan shape

Wrapper call: opaque `Function Scan on list_overlay_reaction_cloud` (security definer, never
inlined — the same correction every other artifact in this directory carries, reproduced in full
on `master-canvas-modules-overlay.explain.md`). Unwrapped body: the `overlay_sessions` gate is a
CTE scanned once, the two catalogue halves are separate `HashAggregate`s under an `Append`, and
one `Sort` on `(count desc, display_name, entry_id)` feeds the ceiling.

**The leaf scan on `channel_reaction_sends` is sequential at this seed size, and that is honest
rather than surprising.** `channel_reaction_sends_channel_recent_idx on (channel_id, created_at)`
— the index this migration adds, matching the read's exact predicate — **exists in the captured
database** (confirmed in the capture run's own `pg_indexes` listing, reproduced below), and the
planner simply declines it on an 810-row table where a sequential scan costs less than an index
descent. That is the correct choice at this size and says nothing either way about the choice at
scale. What the artefact establishes is that the index is present and that the predicate it was
built for is the predicate the plan actually carries (`Filter: ((sticker_id IS NOT NULL) AND
(created_at > (CURRENT_TIMESTAMP - '00:01:00'::interval)))`, `Rows Removed by Filter: 260`).

The channel predicate is applied as a hash join against the one-row session CTE rather than as an
index condition, for the same size reason. `Seq Scan on overlay_sessions` likewise, on a one-row
table.

**A note on the two passes over `channel_reaction_sends`.** The `union all` scans the table twice
— once for the catalogue half, once for the creator-pack half — because the two halves join
different catalogues (`sticker_catalogue_entries`, `creator_sticker_packs`) with different keys.
Collapsing them into one pass would need a `full join` of both catalogues or a `coalesce` over two
`left join`s, both of which read worse and neither of which was measured to be faster. This is
recorded as an open question for whoever has a realistic reaction volume, not optimised
speculatively.

## Raw EXPLAIN output — literal function-call query

```
Function Scan on list_overlay_reaction_cloud  (cost=0.25..10.25 rows=1000 width=88) (actual time=1.998..1.999 rows=5 loops=1)
  Buffers: shared hit=831
Planning Time: 0.026 ms
Execution Time: 2.026 ms
```

## Raw EXPLAIN output — supplementary: function body unwrapped, parameters substituted with the same seeded literal values

This is the real plan for the SQL text covered by `query_hash` above (the function body, not the
wrapper call). The trailing `limit` is omitted from this substitution because the captured case is
the configured-but-unset one, where it is `LIMIT NULL` — no limit, and no plan node.

```
Sort  (cost=59.53..59.58 rows=17 width=61) (actual time=0.259..0.260 rows=5 loops=1)
  Sort Key: (count(*)) DESC, catalogue.display_name, send.sticker_id
  Sort Method: quicksort  Memory: 25kB
  Buffers: shared hit=30
  CTE authorised_session
    ->  Seq Scan on overlay_sessions "overlay"  (cost=0.00..1.02 rows=1 width=16) (actual time=0.003..0.003 rows=1 loops=1)
          Filter: ((revoked_at IS NULL) AND (id = '00000000-0000-4000-8000-000000009941'::uuid) AND (token_fingerprint = 'ab5f4cf2f9c6e6b2d4b8a0a1f3c5e7d9b1a3c5e7f9b1d3f5a7c9e1b3d5f7a9c1'::text) AND (expires_at > CURRENT_TIMESTAMP))
          Buffers: shared hit=1
  ->  Append  (cost=32.81..58.17 rows=17 width=61) (actual time=0.184..0.234 rows=5 loops=1)
        Buffers: shared hit=21
        ->  HashAggregate  (cost=32.81..32.97 rows=16 width=61) (actual time=0.183..0.184 rows=4 loops=1)
              Group Key: send.sticker_id, catalogue.display_name
              Batches: 1  Memory Usage: 24kB
              Buffers: shared hit=11
              ->  Hash Join  (cost=1.12..30.70 rows=282 width=21) (actual time=0.029..0.150 rows=400 loops=1)
                    Hash Cond: (send.sticker_id = catalogue.id)
                    Buffers: shared hit=11
                    ->  Hash Join  (cost=0.03..28.15 rows=282 width=16) (actual time=0.016..0.106 rows=400 loops=1)
                          Hash Cond: (send.channel_id = authorised_session.channel_id)
                          Buffers: shared hit=10
                          ->  Seq Scan on channel_reaction_sends send  (cost=0.00..23.18 rows=565 width=32) (actual time=0.003..0.060 rows=550 loops=1)
                                Filter: ((sticker_id IS NOT NULL) AND (created_at > (CURRENT_TIMESTAMP - '00:01:00'::interval)))
                                Rows Removed by Filter: 260
                                Buffers: shared hit=9
                          ->  Hash  (cost=0.02..0.02 rows=1 width=16) (actual time=0.007..0.007 rows=1 loops=1)
                                Buckets: 1024  Batches: 1  Memory Usage: 9kB
                                Buffers: shared hit=1
                                ->  CTE Scan on authorised_session  (cost=0.00..0.02 rows=1 width=16) (actual time=0.004..0.004 rows=1 loops=1)
                                      Buffers: shared hit=1
                    ->  Hash  (cost=1.04..1.04 rows=4 width=21) (actual time=0.007..0.007 rows=4 loops=1)
                          Buckets: 1024  Batches: 1  Memory Usage: 9kB
                          Buffers: shared hit=1
                          ->  Seq Scan on sticker_catalogue_entries catalogue  (cost=0.00..1.04 rows=4 width=21) (actual time=0.001..0.001 rows=4 loops=1)
                                Buffers: shared hit=1
        ->  HashAggregate  (cost=25.10..25.11 rows=1 width=66) (actual time=0.049..0.049 rows=1 loops=1)
              Group Key: send_1.pack_sticker_id, pack.display_name
              Batches: 1  Memory Usage: 24kB
              Buffers: shared hit=10
              ->  Nested Loop  (cost=1.02..24.93 rows=22 width=26) (actual time=0.022..0.043 rows=60 loops=1)
                    Join Filter: (send_1.channel_id = authorised_session_1.channel_id)
                    Buffers: shared hit=10
                    ->  CTE Scan on authorised_session authorised_session_1  (cost=0.00..0.02 rows=1 width=16) (actual time=0.000..0.000 rows=1 loops=1)
                    ->  Hash Join  (cost=1.02..24.35 rows=45 width=42) (actual time=0.021..0.037 rows=60 loops=1)
                          Hash Cond: (send_1.pack_sticker_id = pack.id)
                          Buffers: shared hit=10
                          ->  Seq Scan on channel_reaction_sends send_1  (cost=0.00..23.18 rows=45 width=32) (actual time=0.010..0.021 rows=60 loops=1)
                                Filter: ((pack_sticker_id IS NOT NULL) AND (created_at > (CURRENT_TIMESTAMP - '00:01:00'::interval)))
                                Rows Removed by Filter: 750
                                Buffers: shared hit=9
                          ->  Hash  (cost=1.01..1.01 rows=1 width=26) (actual time=0.004..0.004 rows=1 loops=1)
                                Buckets: 1024  Batches: 1  Memory Usage: 9kB
                                Buffers: shared hit=1
                                ->  Seq Scan on creator_sticker_packs pack  (cost=0.00..1.01 rows=1 width=26) (actual time=0.001..0.001 rows=1 loops=1)
                                      Buffers: shared hit=1
Planning:
  Buffers: shared hit=286
Planning Time: 0.778 ms
Execution Time: 0.330 ms
```

## Indexes present on `channel_reaction_sends` in the captured database

Recorded because the claim "the index exists, the planner merely declined it at this size" is
otherwise unverifiable from the plan alone.

```
channel_reaction_sends_channel_recent_idx
channel_reaction_sends_pkey
```
