# giveaway-tournament — EXPLAIN plan artifact (RT-12; §6 module #17, new in PRF-02 slice 6)

Function: `app_private.list_overlay_giveaway_tournament(uuid, text)`
Defined at: `packages/db/migrations/0142_v1_prf02_giveaway_tournament.sql:856` (block spans lines 856-893)

New function, new in this slice, and the whole server-side read cost of §6 module #17. Captured
as part of this slice's own work rather than left for a later one, per the "capture the artefact
when the query is written" discipline RT-12's closure established.

**The creator-facing functions have no artefact here, deliberately.**
`app_private.open_giveaway`, `update_giveaway_entry_count`, `close_giveaway`,
`list_channel_giveaway`, `start_tournament`, `set_tournament_progress`, `conclude_tournament` and
`list_channel_tournament` run on the MAIN pool through
`apps/api/src/db/giveaway-tournament-store.ts`, not on RT-10/RT-11's `derivedReadSql`, and none of
them is a widget-backing derived read — so none of `scan-required-queries.mjs`'s three rules
requires one. They are asserted behaviourally instead, in
`packages/db/tests/prf02_slice6_giveaway_tournament.sql`. This is the identical structural position
`db/lobby-status-store.ts`, `db/stream-mission-store.ts` and `db/safe-mode-store.ts` already occupy.

## Exact query run

Seeded overlay session id: `00000000-0000-4000-8000-000000009941`
Seeded token fingerprint: `b4e2d9f7a1c3560829fb4d7e0a3c5f8b6d1e3a5c7f9b1d3e5a7c9f1b3d5e7a92`
Seeded data: **102 channels (100 of them creator tier), 51 overlay sessions, 400 lobby sessions,
400 giveaways and 400 tournaments** — per channel, one OPEN giveaway beside **three CLOSED ones**,
one RUNNING tournament beside **three CONCLUDED ones**, and one OPEN lobby beside three closed
ones. Both groups exist in each case so the channel predicate and the `closed_at is null` /
`concluded_at is null` predicates are each captured filtering rather than matching everything.
`ANALYZE` was run before capture.

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM app_private.list_overlay_giveaway_tournament('00000000-0000-4000-8000-000000009941'::uuid, 'b4e2d9f7a1c3560829fb4d7e0a3c5f8b6d1e3a5c7f9b1d3e5a7c9f1b3d5e7a92');
```

The call returns **one row of six aggregate values**, out of 400 giveaways and 400 tournaments:

```
 entry_count |        entry_closes_at        | tournament_current_round | tournament_total_rounds | tournament_completed_matches_in_round | tournament_matches_in_round
-------------+-------------------------------+--------------------------+-------------------------+---------------------------------------+-----------------------------
         143 | 2026-09-17 03:59:40.718372+00 |                        2 |                       3 |                                     1 |                           2
```

**Six aggregate values. That is the whole projection** — §17's entry state and bracket state, and
nothing else. `packages/db/tests/prf02_slice6_giveaway_tournament.sql` asserts the returned column
set directly (from `pg_get_function_result` and from a table materialised out of a live call).

There is **no winner** in it, and there cannot be one in this slice: §17.1 permits an announcement
only WITH CONSENT and no consent mechanism exists in this schema; a winner would be a participant
identifier on an aggregate-only path; and nothing could produce one, because the mechanic is not
built (§17.1's decision of **2026-09-13** — free-entry and skill-based formats only,
supporter-weighted odds not built) and `GIV-07` gates chance-based formats on a legal review that
has not happened. **`GIV-07` stays Blocked and nothing in this artefact touches it.**

There is likewise **no participant identifier, in-game name, Discord name, viewer id, anonymous
identity, session id, postal field or contact detail**, and no giveaway, tournament or lobby id
either — and not one of them exists as a column anywhere in migration `0142` for a future read to
start returning. No prize, escrow, custody, fulfilment, delivery or claim column exists either:
BharatStudio never holds, escrows, ships or guarantees a prize, and the creator is the promoter.

### The entitlement gate is in the query, and this is the evidence

The same call, after moving the same channel from `creator` to `pro` with a new entitlement version
and nothing else changed — same valid, unexpired, unrevoked token, same open giveaway, same running
tournament:

```
 rows_for_a_pro_channel
------------------------
                      0
```

§30.3 places the Lobby and tournament engine at Creator+, and the owner's decision of 2026-09-16
makes the check `tier in ('creator','studio')` **or** an active Events Pack grant. That check is
migration `0140`'s `app_private.events_pack_entitled`, **called here rather than reimplemented** —
`0142` does not define an entitlement function of its own and does not mention the pack grant key
at all, which is what keeps `0140`'s own "nothing can grant the Events Pack" assertion true after
this migration lands. The pack side ships with **no grant path**, so today's behaviour is exactly
"included at Creator+", which is what the zero above shows. The tier gate is on the MODULE; the
creator's own reads of the same giveaway and tournament are not gated and still answer for that Pro
channel.

query_hash: `35e634ad4c3141ed057614113c6b9a9854a2a6ebbc3d4423c09b547cabfc67ca`

Computed by extracting the exact text from the `create or replace function app_private.list_overlay_giveaway_tournament(` line through the terminating `$$;` line (inclusive) out of `packages/db/migrations/0142_v1_prf02_giveaway_tournament.sql` as it exists at capture time, then `sha256sum`-ing that extracted text verbatim (UTF-8, including original newlines/whitespace). This is the identical extraction `packages/db/explain-plans/check-plans.mjs` re-runs against the migration file's CURRENT contents on every check; a hash mismatch means the function body changed since this artifact was captured and the plan needs re-verification.

captured_at: 2026-09-17T00:00:00Z
postgres_version: postgres:16-alpine (PostgreSQL 16.14 on aarch64-unknown-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit)

This EXPLAIN was captured against a minimally-seeded local database (102 channels, 400 giveaways,
400 tournaments, 400 lobby sessions, 51 overlay sessions), **not** FULL-PRODUCT-DEFINITION.md
§37.4's production-scale dataset (500 channels / 2,000,000 payments / 5,000,000 alert events /
200,000 supporter identities). It is a plan-shape change detector only — proof that the query still
resolves to the same kind of plan as when it was last captured — and it is **NOT** evidence that
any §19.4 performance budget is met at production scale, nor any form of production, provider,
device, network or release readiness. §19.0's RT-07 remains Blocked and is the only row that can
supply OBS/Chromium/device/soak evidence.

## Plan shape

```
 Function Scan on list_overlay_giveaway_tournament  (cost=0.25..10.25 rows=1000 width=28) (actual time=2.014..2.014 rows=1 loops=1)
   Buffers: shared hit=855
 Planning Time: 0.029 ms
 Execution Time: 2.039 ms
```

A `security definer` SQL function is opaque to `EXPLAIN` from outside, so the same body was also
run inline to make the plan visible — the identical predicates, joins and ordering:

```
 Limit  (cost=16.39..24.29 rows=1 width=28) (actual time=0.503..0.503 rows=1 loops=1)
   Buffers: shared hit=202
   ->  Nested Loop Left Join  (cost=16.39..24.29 rows=1 width=28) (actual time=0.502..0.503 rows=1 loops=1)
         Buffers: shared hit=202
         ->  Merge Right Join  (cost=16.11..23.51 rows=1 width=36) (actual time=0.497..0.497 rows=1 loops=1)
               Merge Cond: (tournament.channel_id = session.channel_id)
               Filter: ((giveaway.id IS NOT NULL) OR (tournament.id IS NOT NULL))
               Buffers: shared hit=199
               ->  Index Scan using tournaments_channel_running_idx on tournaments tournament  (cost=0.14..14.64 rows=100 width=56) (actual time=0.009..0.010 rows=1 loops=1)
                     Buffers: shared hit=2
               ->  Sort  (cost=15.97..15.98 rows=1 width=44) (actual time=0.486..0.486 rows=1 loops=1)
                     Sort Key: session.channel_id
                     Sort Method: quicksort  Memory: 25kB
                     Buffers: shared hit=197
                     ->  Merge Right Join  (cost=8.57..15.96 rows=1 width=44) (actual time=0.479..0.480 rows=1 loops=1)
                           Merge Cond: (giveaway.channel_id = session.channel_id)
                           Buffers: shared hit=197
                           ->  Index Scan using giveaways_channel_open_idx on giveaways giveaway  (cost=0.14..14.64 rows=100 width=44) (actual time=0.004..0.004 rows=2 loops=1)
                                 Buffers: shared hit=2
                           ->  Sort  (cost=8.43..8.43 rows=1 width=16) (actual time=0.474..0.475 rows=1 loops=1)
                                 Sort Key: session.channel_id
                                 Sort Method: quicksort  Memory: 25kB
                                 Buffers: shared hit=195
                                 ->  Index Scan using overlay_sessions_pkey on overlay_sessions session  (cost=0.14..8.42 rows=1 width=16) (actual time=0.468..0.468 rows=1 loops=1)
                                       Index Cond: (id = '00000000-0000-4000-8000-000000009941'::uuid)
                                       Filter: ((revoked_at IS NULL) AND (token_fingerprint = '…'::text) AND (expires_at > CURRENT_TIMESTAMP) AND app_private.events_pack_entitled(channel_id))
                                       Buffers: shared hit=195
         ->  Index Scan using lobby_sessions_pkey on lobby_sessions lobby  (cost=0.27..0.77 rows=1 width=20) (actual time=0.004..0.004 rows=1 loops=1)
               Index Cond: (id = tournament.lobby_session_id)
               Buffers: shared hit=3
 Planning:
   Buffers: shared hit=414
 Planning Time: 0.962 ms
 Execution Time: 0.559 ms
```

### What the shape says, and what it does not

- **Every one of the four relations is reached by an index scan, and not one is a sequential
  scan.** The session is found by primary key. The open giveaway is found through
  `giveaways_channel_open_idx` and the running tournament through
  `tournaments_channel_running_idx` — the two PARTIAL unique indexes migration `0142` creates on
  `(channel_id) where closed_at is null` and `(channel_id) where concluded_at is null`. Each of
  those indexes does two jobs at once: it is the §12.7 "at most the current one" guarantee, and it
  is also why the 300 closed giveaways and 300 concluded tournaments are never visited —
  `Buffers: shared hit=2` on each node, against 400 stored rows apiece.
- **The lobby is reached by primary key, and that node is the §17.2 dependency made visible.**
  `Index Cond: (id = tournament.lobby_session_id)` is where the bracket's field size comes from:
  `tournament_total_rounds` and `tournament_matches_in_round` are computed from
  `lobby_sessions.seat_count` at read time and are stored nowhere. Three buffer hits for the whole
  of the bracket's shape, and no second copy that could drift from the lobby's own number.
  Note that the join is `on lobby.id = tournament.lobby_session_id` **and nothing else** — never
  `lobby.closed_at is null` — so closing a lobby cannot silently blank a running bracket, and the
  lobby row stays durable per §12.6.
- **`events_pack_entitled` is evaluated as a filter on the session row**, so exactly one channel's
  entitlement is read per call, not one per giveaway or per tournament.
- **No ordering is needed and none is asked for.** The two partial unique indexes mean at most one
  live giveaway and at most one live tournament can exist per channel, so the result is at most one
  row by construction; `limit 1` is belt to those braces. That is the one shape difference from
  `list_overlay_lobby_status`, which keeps an `order by opened_at desc` it does not strictly need
  either.
- **The two `Sort` nodes cost 25kB each and sort one row each.** They are the planner's chosen
  merge-join strategy over single-row inputs, not a scan of anything.
- **What this does not say.** It says nothing about a real OBS browser source, a real Chromium
  process, a real device or a real eight-hour broadcast. RT-07 is Blocked and remains the only row
  that can supply that evidence.
