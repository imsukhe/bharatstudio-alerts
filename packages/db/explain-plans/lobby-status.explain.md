# lobby-status — EXPLAIN plan artifact (RT-12; §6 module #16, new in PRF-02 slice 6)

Function: `app_private.list_overlay_lobby_status(uuid, text)`
Defined at: `packages/db/migrations/0140_v1_prf02_lobby_status.sql:548` (block spans lines 548-569)

New function, new in this slice, and the whole server-side read cost of §6 module #16. Captured
as part of this slice's own work rather than left for a later one, per the "capture the artefact
when the query is written" discipline RT-12's closure established.

**The creator-facing functions have no artefact here, deliberately.**
`app_private.open_lobby_session`, `app_private.update_lobby_session_counts`,
`app_private.close_lobby_session` and `app_private.list_channel_lobby_session` run on the MAIN
pool through `apps/api/src/db/lobby-status-store.ts`, not on RT-10/RT-11's `derivedReadSql`, and
none of them is a widget-backing derived read — so none of `scan-required-queries.mjs`'s three
rules requires one. They are asserted behaviourally instead, in
`packages/db/tests/prf02_slice6_lobby_status.sql`. This is the identical structural position
`db/stream-mission-store.ts` and `db/safe-mode-store.ts` already occupy.

## Exact query run

Seeded overlay session id: `00000000-0000-4000-8000-000000009841`
Seeded token fingerprint: `c7f1a3e5b9d2470816fa4c8e0b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1a3c5e7b90`
Seeded data: **100 channels, all creator tier, 51 overlay sessions and 400 lobby sessions** — one
OPEN lobby per channel and **three CLOSED ones per channel (300 rows the read must skip)**. Both
groups exist so the channel predicate and the `closed_at is null` predicate are each captured
filtering rather than matching everything. `ANALYZE` was run before capture.

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM app_private.list_overlay_lobby_status('00000000-0000-4000-8000-000000009841'::uuid, 'c7f1a3e5b9d2470816fa4c8e0b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1a3c5e7b90');
```

The call returns **one row of three integers**, out of 400 stored lobby sessions:

```
 seat_count | confirmed_seat_count | queue_count
------------+----------------------+-------------
         16 |                    8 |          12
```

**Three columns. That is the whole projection** — §16's "aggregate status only … Never player
identifiers, never Discord names, never codes or passwords" is a property of this query rather
than of the renderer, and `packages/db/tests/prf02_slice6_lobby_status.sql` asserts the returned
column set directly (from `pg_get_function_result` and from a table materialised out of a live
call). No room code, no password, no seat token, no player identifier, no in-game name, no
Discord name, no viewer id, no anonymous identity and no session id is in it — and not one of
them exists as a column anywhere in migration `0140` for a future read to start returning.

### The entitlement gate is in the query, and this is the evidence

The same call, after moving the same channel from `creator` to `pro` with a new entitlement
version and nothing else changed — same valid, unexpired, unrevoked token, same open lobby:

```
 rows_for_a_pro_channel
------------------------
                      0
```

§30.3 places the Lobby Engine at Creator+, and the owner's decision of 2026-09-16 makes the check
`tier in ('creator','studio')` **or** an active Events Pack grant. The pack side ships with **no
grant path** — nothing in the schema can write that key — so today's behaviour is exactly
"included at Creator+", which is what the zero above shows. The tier gate is on the MODULE; the
creator's own read of the same lobby (`app_private.list_channel_lobby_session`) is not gated and
still answers for that Pro channel.

query_hash: `24e4a882bf43a0043e54b6d25b9ab14d11430f898719334789e0c92b11c27e10`

Computed by extracting the exact text from the `create or replace function app_private.list_overlay_lobby_status(` line through the terminating `$$;` line (inclusive) out of `packages/db/migrations/0140_v1_prf02_lobby_status.sql` as it exists at capture time, then `sha256sum`-ing that extracted text verbatim (UTF-8, including original newlines/whitespace). This is the identical extraction `packages/db/explain-plans/check-plans.mjs` re-runs against the migration file's CURRENT contents on every check; a hash mismatch means the function body changed since this artifact was captured and the plan needs re-verification.

captured_at: 2026-09-16T00:00:00Z
postgres_version: postgres:16-alpine (PostgreSQL 16.14 on aarch64-unknown-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit)

This EXPLAIN was captured against a minimally-seeded local database (100 channels, 400 lobby
sessions, 51 overlay sessions), **not** FULL-PRODUCT-DEFINITION.md §37.4's production-scale
dataset (500 channels / 2,000,000 payments / 5,000,000 alert events / 200,000 supporter
identities). It is a plan-shape change detector only — proof that the query still resolves to the
same kind of plan as when it was last captured — and it is **NOT** evidence that any §19.4
performance budget is met at production scale, nor any form of production, provider, device,
network or release readiness. §19.0's RT-07 remains Blocked and is the only row that can supply
OBS/Chromium/device/soak evidence.

## Plan shape

```
 Function Scan on list_overlay_lobby_status  (cost=0.25..10.25 rows=1000 width=12) (actual time=1.856..1.856 rows=1 loops=1)
   Buffers: shared hit=744
 Planning Time: 0.023 ms
 Execution Time: 1.874 ms
```

A `security definer` SQL function is opaque to `EXPLAIN` from outside, so the same body was also
run inline to make the plan visible — the identical predicates, joins and ordering:

```
 Limit  (cost=16.60..16.60 rows=1 width=20) (actual time=0.482..0.483 rows=1 loops=1)
   Buffers: shared hit=203
   ->  Sort  (cost=16.60..16.60 rows=1 width=20) (actual time=0.482..0.482 rows=1 loops=1)
         Sort Key: lobby.opened_at DESC
         Sort Method: quicksort  Memory: 25kB
         Buffers: shared hit=203
         ->  Nested Loop  (cost=0.28..16.59 rows=1 width=20) (actual time=0.467..0.467 rows=1 loops=1)
               Buffers: shared hit=200
               ->  Index Scan using overlay_sessions_pkey on overlay_sessions session  (cost=0.14..8.42 rows=1 width=16) (actual time=0.461..0.461 rows=1 loops=1)
                     Index Cond: (id = '00000000-0000-4000-8000-000000009841'::uuid)
                     Filter: ((revoked_at IS NULL) AND (token_fingerprint = '…'::text) AND (expires_at > CURRENT_TIMESTAMP) AND app_private.events_pack_entitled(channel_id))
                     Buffers: shared hit=198
               ->  Index Scan using lobby_sessions_channel_open_idx on lobby_sessions lobby  (cost=0.14..8.16 rows=1 width=36) (actual time=0.004..0.004 rows=1 loops=1)
                     Index Cond: (channel_id = session.channel_id)
                     Buffers: shared hit=2
 Planning:
   Buffers: shared hit=274
 Planning Time: 0.702 ms
 Execution Time: 0.509 ms
```

### What the shape says, and what it does not

- **Both sides are index scans, and neither is a sequential scan.** The session is found by
  primary key; the lobby is found through `lobby_sessions_channel_open_idx`, the PARTIAL unique
  index on `(channel_id) where closed_at is null` that migration `0140` creates. That index is
  doing two jobs at once here: it is the §12.7 "at most the current lobby" guarantee, and it is
  also why the 300 closed rows are never visited — `Buffers: shared hit=2` on that node, against
  400 stored rows.
- **The sort over `opened_at desc` costs nothing** because the partial unique index already means
  at most one row can reach it. The `order by` plus `limit 1` is belt to that braces, the same
  shape `list_overlay_stream_mission` (migration `0135`) uses.
- **`events_pack_entitled` is evaluated as a filter on the session row**, so exactly one channel's
  entitlement is read per call, not one per lobby.
- **What this does not say.** It says nothing about a real OBS browser source, a real Chromium
  process, a real device or a real eight-hour broadcast. RT-07 is Blocked and remains the only row
  that can supply that evidence.
