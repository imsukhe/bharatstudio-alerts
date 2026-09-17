# media-queue — EXPLAIN plan artifact (RT-12; §6 module #20, new in PRF-02 slice 7)

Function: `app_private.list_overlay_media_queue(uuid, text)`
Defined at: `packages/db/migrations/0148_v1_prf02_slice7_media_queue_url_hardening.sql:317` (block spans lines 317-350)

New function in migration 0146; **URL-hardened by migration 0148** (a hostile code review found
`storage_url`/`thumbnail_url` accepted an arbitrary third-party URL with no host allowlist —
§9.1.1/§19.1). Migration 0148 drops and recreates this function (its OUT columns changed, which
`create or replace function` cannot do — the same reason `get_overlay_events` in migration 0127 used
a plain `create function`) so that it returns `gcs_object_key` / `thumbnail_gcs_object_key` — a
content-key fragment, never a URL — in place of `storage_url` / `thumbnail_url`. Resolution to a
playable URL against the server's own configured CDN base now happens exclusively in
`apps/api/src/db/media-queue-overlay-store.ts`, never in SQL. This artifact was re-captured against
migration 0148's function body rather than left pointing at 0146's now-superseded one, per RT-12's
"capture the artefact when the query is written" discipline.

**The creator-facing functions have no artefact here, deliberately.**
`app_private.enqueue_media_queue_item`, `list_channel_media_queue_items`, `update_media_queue_item`
and `set_media_queue_item_status` run on the MAIN pool through
`apps/api/src/db/media-queue-store.ts`, not on RT-10/RT-11's `derivedReadSql`, and none of them is a
widget-backing derived read — so none of `scan-required-queries.mjs`'s three rules requires one.
They are asserted behaviourally instead, in `packages/db/tests/prf02_slice7_media_queue.sql`. This
is the identical structural position `db/giveaway-tournament-store.ts`, `db/lobby-status-store.ts`
and `db/stream-mission-store.ts` already occupy.

## Exact query run

Seeded overlay session id: `00000000-0000-4000-9300-000000000042`
Seeded token fingerprint: `explain-mq-fingerprint-42`
Seeded data: **102 channels (100 of them carrying a media queue), 100 overlay sessions, and 400
media queue items** — per channel, **three LIVE items** (`status = 'queued'`, `enabled = true`)
beside **one PLAYED item** (excluded from the live partial index). `ANALYZE` was run before capture.
This re-capture used the same scale as the original 0146 artifact, seeded and run against a fresh
`postgres:16-alpine` container with every migration through 0148 applied.

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM app_private.list_overlay_media_queue('00000000-0000-4000-9300-000000000042'::uuid, 'explain-mq-fingerprint-42');
```

```
 Function Scan on list_overlay_media_queue  (cost=0.25..10.25 rows=1000 width=196) (actual time=1.156..1.156 rows=2 loops=1)
   Buffers: shared hit=582
 Planning Time: 0.026 ms
 Execution Time: 1.181 ms
```

The call returns **exactly two rows** ("current" and "next"), out of 400 stored media queue items and
300 LIVE ones (3 per channel × 100 channels) — carrying a **KEY**, never a URL:

```
 queue_slot |    title    | media_kind | mime_type |    gcs_object_key    | thumbnail_gcs_object_key | duration_ms 
------------+-------------+------------+-----------+----------------------+--------------------------+-------------
 current    | live one 42 | image      | image/png | media-queue/42/1.png |                          |            
 next       | live two 42 | video      | video/mp4 | media-queue/42/2.mp4 |                          |        4000
```

**At most two rows. That is the whole surface** — §12.7's Overlay row authorises "current and next
alert state" in those exact words, and this reuses the SAME bound
`apps/web/app/overlay/canvas/modules/support-theater-module.ts:68-72` already established for this
codebase rather than inventing a queue-depth number. There is no aggregate count of how many items
are queued anywhere in this output, and no item id, submitter identity or viewer identity either —
`packages/db/tests/prf02_slice7_media_queue.sql` (MED20.2) asserts the returned column set directly
(from `pg_get_function_result` and from a table materialised out of a live call), and now asserts
`gcs_object_key`/`thumbnail_gcs_object_key`, not `storage_url`/`thumbnail_url`.

### A `security definer` SQL function is opaque to EXPLAIN, so the same body was also run inline

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT case row_number() over (order by item.created_at asc, item.id asc)
         when 1 then 'current' else 'next' end,
       item.title, item.media_kind, item.mime_type,
       item.gcs_object_key, item.thumbnail_gcs_object_key, item.duration_ms
  FROM public.overlay_sessions session
  JOIN public.media_queue_items item
    ON item.channel_id = session.channel_id
   AND item.status = 'queued'
   AND item.enabled
 WHERE session.id = '00000000-0000-4000-9300-000000000042'::uuid
   AND session.token_fingerprint = 'explain-mq-fingerprint-42'
   AND session.revoked_at is null
   AND session.expires_at > current_timestamp
 ORDER BY item.created_at asc, item.id asc
 LIMIT 2;
```

```
 Limit  (cost=15.20..15.24 rows=2 width=139) (actual time=0.043..0.044 rows=2 loops=1)
   Buffers: shared hit=11
   ->  WindowAgg  (cost=15.20..15.27 rows=3 width=139) (actual time=0.042..0.043 rows=2 loops=1)
         Buffers: shared hit=11
         ->  Sort  (cost=15.20..15.21 rows=3 width=107) (actual time=0.038..0.039 rows=2 loops=1)
               Sort Key: item.created_at, item.id
               Sort Method: quicksort  Memory: 25kB
               Buffers: shared hit=11
               ->  Nested Loop  (cost=4.30..15.17 rows=3 width=107) (actual time=0.018..0.023 rows=3 loops=1)
                     Buffers: shared hit=5
                     ->  Seq Scan on overlay_sessions session  (cost=0.00..4.00 rows=1 width=16) (actual time=0.005..0.008 rows=1 loops=1)
                           Filter: ((revoked_at IS NULL) AND (id = '00000000-0000-4000-9300-000000000042'::uuid) AND (token_fingerprint = 'explain-mq-fingerprint-42'::text) AND (expires_at > CURRENT_TIMESTAMP))
                           Rows Removed by Filter: 99
                           Buffers: shared hit=2
                     ->  Bitmap Heap Scan on media_queue_items item  (cost=4.30..11.14 rows=3 width=123) (actual time=0.012..0.013 rows=3 loops=1)
                           Recheck Cond: ((session.channel_id = channel_id) AND (status = 'queued'::text) AND enabled)
                           Heap Blocks: exact=1
                           Buffers: shared hit=3
                           ->  Bitmap Index Scan on media_queue_items_channel_live_idx  (cost=0.00..4.29 rows=3 width=0) (actual time=0.006..0.006 rows=3 loops=1)
                                 Index Cond: (channel_id = session.channel_id)
                                 Buffers: shared hit=2
 Planning:
   Buffers: shared hit=208
 Planning Time: 0.510 ms
 Execution Time: 0.094 ms
```

### What the shape says, and what it does not

- **`media_queue_items` is reached through `media_queue_items_channel_live_idx`, the PARTIAL index
  migration 0146 creates and migration 0148 leaves untouched** (`on (channel_id, created_at asc)
  where status = 'queued' and enabled`) — a Bitmap Index Scan filtered to `channel_id`, with
  `Recheck Cond` confirming `status` and `enabled` are already satisfied by the index's own
  predicate. Only 300 of the 400 stored items (the LIVE ones) are ever reachable through this index
  at all; the 100 played items are invisible to it structurally, not filtered out row-by-row.
- **`overlay_sessions` is reached with a Seq Scan, not an index scan, and that is the planner's
  correct choice at this table's size** (100 rows seeded here) rather than a missing index:
  `overlay_sessions` carries its own primary key on `id` (used by every other `list_overlay_*`
  function's identical predicate shape, e.g. `list_overlay_giveaway_tournament`'s artefact), and at
  100 rows a full scan costs less than an index probe. This is a seeding-scale artefact of the local
  test database, not evidence about production-scale behaviour — see the caveat below.
- **`row_number() over (...)` becomes a `WindowAgg` over a `Sort`**, evaluated on the (at most 3, in
  this seed) LIVE rows for one channel — never over the channel's full history and never over more
  than one channel's rows, because the join and the `where session.id = ...` predicate scope
  everything to a single overlay session before the sort ever runs.
- **`LIMIT 2` is the only ceiling this query needs.** There is no queue-depth number chosen here:
  2 is the same "current and next" bound `support-theater-module.ts:68-72` already uses, and the
  window function simply labels which of the (at most 3) live rows fall inside that limit.
- **Migration 0148's column rename (`storage_url`/`thumbnail_url` → `gcs_object_key`/
  `thumbnail_gcs_object_key`) changes the plan's `width` figures slightly (both columns keep the
  same underlying `text` type and the same partial index) but changes no scan strategy, no join
  method and no index used** — the Bitmap Index Scan on `media_queue_items_channel_live_idx` and the
  Seq Scan on `overlay_sessions` are identical to the pre-0148 capture.
- **Buffers stay small** for the inline query even though the seeded database holds 400 media queue
  items and 100 overlay sessions — the partial index and the single-row session lookup are why.
- **What this does not say.** It says nothing about a real OBS browser source, a real Chromium
  process, a real device or a real eight-hour broadcast, and nothing about production-scale data
  volume (FULL-PRODUCT-DEFINITION.md §37.4: 500 channels / 2,000,000 payments / 5,000,000 alert
  events / 200,000 supporter identities). RT-07 is Blocked and remains the only row that can supply
  that evidence. This EXPLAIN is a plan-shape change detector only — proof that the query resolves
  to an index-backed plan today, re-checked against the migration's current function body by
  `packages/db/explain-plans/check-plans.mjs` on every run — not a performance, provider or release
  guarantee of any kind.

query_hash: `583cf25a1bcfbeb7640f3ccc0526cdf45e404b6dd9a02ea920844c054b1cddbb`

Computed by extracting the exact text from the `create function app_private.list_overlay_media_queue(`
line through the terminating `$$;` line (inclusive) out of
`packages/db/migrations/0148_v1_prf02_slice7_media_queue_url_hardening.sql` as it exists at capture
time, then `sha256sum`-ing that extracted text verbatim (UTF-8, including original
newlines/whitespace). This is the identical extraction `packages/db/explain-plans/check-plans.mjs`
re-runs against the migration file's CURRENT contents on every check; a hash mismatch means the
function body changed since this artifact was captured and the plan needs re-verification. Note the
extraction matches a plain `create function` line (not `create or replace function`), because
migration 0148 drops the function before recreating it with different OUT columns — `create or
replace function` cannot change a function's return-table column list.

captured_at: 2026-09-17T00:00:00Z
postgres_version: postgres:16-alpine (PostgreSQL 16.14 on aarch64-unknown-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit)

This EXPLAIN was captured against a minimally-seeded local database (102 channels, 400 media queue
items, 100 overlay sessions) with every migration through 0148 applied, **not**
FULL-PRODUCT-DEFINITION.md §37.4's production-scale dataset. It is a plan-shape change detector only,
exactly as `giveaway-tournament.explain.md`, `lobby-status.explain.md` and every other RT-12
artefact in this directory state for themselves.
