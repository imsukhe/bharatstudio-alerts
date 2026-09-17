# sponsor-card — EXPLAIN plan artifact (RT-12; §6 module #11, new in PRF-02 slice 7)

Function: `app_private.list_overlay_sponsor_card(uuid, text)`
Defined at: `packages/db/migrations/0145_v1_prf02_sponsor_card.sql:317` (block spans lines 317-339)

New function, new in this slice, and the whole server-side read cost of §6 module #11. Captured
as part of this slice's own work rather than left for a later one, per the "capture the artefact
when the query is written" discipline RT-12's closure established.

**The creator-facing functions have no artefact here, deliberately.** `app_private.upsert_
sponsor_card` and `list_channel_sponsor_card` run on the MAIN pool through
`apps/api/src/db/sponsor-card-store.ts`, not on RT-10/RT-11's `derivedReadSql`, and neither is a
widget-backing derived read — so none of `scan-required-queries.mjs`'s three rules requires one.
This is the identical structural position `db/lobby-status-store.ts`, `db/stream-mission-store.ts`
and `db/giveaway-tournament-store.ts` already occupy.

query_hash: `2f9825eeb8099a378524710e7edf114502928d410b08dd72dd969108106a5d08`

Computed by extracting the exact text from the `create or replace function
app_private.list_overlay_sponsor_card(` line through the terminating `$$;` line (inclusive) out of
`packages/db/migrations/0145_v1_prf02_sponsor_card.sql` as it exists at capture time, then
`sha256sum`-ing that extracted text verbatim (UTF-8, including original newlines/whitespace). This
is the identical extraction `packages/db/explain-plans/check-plans.mjs` re-runs against the
migration file's CURRENT contents on every check; a hash mismatch means the function body changed
since this artifact was captured and the plan needs re-verification.

captured_at: 2026-09-17T00:00:00Z
postgres_version: postgres:16-alpine (PostgreSQL 16, Debian/Alpine build, 64-bit)

This EXPLAIN was captured against a minimally-seeded local database (101 channels, 101 sponsor
cards, 52 overlay sessions), **not** FULL-PRODUCT-DEFINITION.md §37.4's production-scale dataset
(500 channels / 2,000,000 payments / 5,000,000 alert events / 200,000 supporter identities). It is
a plan-shape change detector only — proof that the query still resolves to the same kind of plan as
when it was last captured — and it is **NOT** evidence that any §19.4 performance budget is met at
production scale, nor any form of production, provider, device, network or release readiness.
§19.0's RT-07 remains Blocked and is the only row that can supply OBS/Chromium/device/soak
evidence.

## Plan shape

```
 Function Scan on list_overlay_sponsor_card  (cost=0.25..10.25 rows=1000 width=96) (actual time=1.434..1.435 rows=1 loops=1)
   Buffers: shared hit=436
 Planning Time: 0.035 ms
 Execution Time: 1.462 ms
```

A `security definer` SQL function is opaque to `EXPLAIN` from outside, so the same body was also
run inline to make the plan visible — the identical predicates, joins and ordering:

```
 Hash Join  (cost=2.05..6.17 rows=1 width=142) (actual time=0.033..0.034 rows=1 loops=1)
   Hash Cond: (card.channel_id = session.channel_id)
   Buffers: shared hit=3
   ->  Seq Scan on sponsor_cards card  (cost=0.00..4.02 rows=39 width=158) (actual time=0.006..0.014 rows=76 loops=1)
         Filter: (enabled AND (((schedule_starts_at IS NULL) AND (schedule_ends_at IS NULL)) OR ((CURRENT_TIMESTAMP >= schedule_starts_at) AND (CURRENT_TIMESTAMP <= schedule_ends_at))))
         Rows Removed by Filter: 25
         Buffers: shared hit=2
   ->  Hash  (cost=2.04..2.04 rows=1 width=16) (actual time=0.008..0.008 rows=1 loops=1)
         Buckets: 1024  Batches: 1  Memory Usage: 9kB
         Buffers: shared hit=1
         ->  Seq Scan on overlay_sessions session  (cost=0.00..2.04 rows=1 width=16) (actual time=0.005..0.006 rows=1 loops=1)
               Filter: ((revoked_at IS NULL) AND (id = '00000000-0000-4000-8000-000000009952'::uuid) AND (token_fingerprint = '…'::text) AND (expires_at > CURRENT_TIMESTAMP))
               Rows Removed by Filter: 51
               Buffers: shared hit=1
 Planning:
   Buffers: shared hit=251
 Planning Time: 0.803 ms
 Execution Time: 0.062 ms
```

The call returns **one row of three fields**, out of 101 stored sponsor cards:

```
    sponsor_name     | logo_mime_type |                             logo_storage_key
---------------------+----------------+-----------------------------------------------------------------------------
 Acme Energy Drinks  | image/png      | 00000000-0000-4000-8000-000000009951/abababababababababababababababababababababababababababababababab
```

**Three fields. That is the whole projection** — a name and, when present, a logo reference, and
nothing else. `packages/db/tests/prf02_slice7_sponsor_card.sql` case SP11.13 asserts the returned
column set directly (from `pg_get_function_result` and from a table materialised out of a live
call). There is **no count, no impression, no exposure, no view, no duration and no "shown at" or
"displayed at"** in it, and none exists as a column anywhere in migration `0145` for a future read
to start returning (case SP11.18 asserts that structurally too, against every function this
migration ships and against `information_schema.columns`).

### Both scans are sequential, and that is correct at this table size, not a defect

`sponsor_cards` holds 101 rows in this seed and `overlay_sessions` holds 52; PostgreSQL's own
planner rejects the unique index on `sponsor_cards(channel_id)` here in favour of `Seq Scan` because
a full scan of a 101-row table is cheaper than a random-access index lookup at this size — the same
threshold behaviour any table this small exhibits, independent of what indexes exist. The unique
index (`unique (channel_id)`, migration `0145`) is what enforces "one sponsor card per channel" as a
database guarantee; whether the planner chooses to use it for a lookup at this row count is a
separate, cost-based decision the planner is free to make either way, and this artefact does not
claim otherwise. `§37.4`'s production-scale seed is the dataset that would actually exercise the
index-scan path; it has not been run here.

### The enabled/schedule gate is in the query, and this is the evidence

The same call, after disabling the same card with nothing else changed — same valid, unexpired,
unrevoked token, same channel:

```
 rows_when_disabled
--------------------
                  0
```

Re-enabling it and re-running the identical call:

```
 rows_when_enabled_again
-------------------------
                       1
```

And after moving its schedule window entirely into the past, still enabled, same token:

```
 rows_outside_schedule
-----------------------
                      0
```

§6's 2026-09-17 decision requires "scheduled placement" to survive as an instruction about the
FUTURE and requires the card to show or hide on its single toggle. Both are enforced **inside**
`app_private.list_overlay_sponsor_card` itself — `card.enabled = true` and the schedule-window
predicate are WHERE-clause conditions on the same query the EXPLAIN above captures, not a
post-filter applied by the API layer. A disabled card, a card outside its window, an unrecognised
token, an expired or revoked session, and a channel with no sponsor card at all are four different
causes that all produce the identical zero-row answer this artefact demonstrates, which is exactly
what lets the API layer collapse all of them to a single `sponsorCard: null` (see
`apps/api/src/routes/master-canvas.ts`'s sponsor-card overlay route).

### What this does not say

It says nothing about a real OBS browser source, a real Chromium process, a real device or a real
eight-hour broadcast, and nothing about performance at `§37.4`'s production scale. `RT-07` is
Blocked and remains the only row that can supply that evidence.
