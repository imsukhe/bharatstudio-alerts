# overlay-events — EXPLAIN plan artifact (RT-12)

Function: `app_private.get_overlay_events(uuid, timestamptz, uuid, integer)`
Defined at: `packages/db/migrations/0127_v1_rt02_overlay_events_artifact_column.sql:33` (block spans lines 33-89)

This is the alert stream itself — the query the overlay's SSE replay runs on every wake, for every overlay session, in `apps/api/src/db/overlay-store.ts`'s `replayRaw`. It is not named `list_overlay_*` (RT-02/0127 dropped and recreated it as `get_overlay_events` to add the `tts_audio_artifact_id` output column — PostgreSQL does not allow `CREATE OR REPLACE FUNCTION` to change a function's OUT columns), which is exactly why the naming-convention scan could not nominate it and why this task exists (`bharatstudio-requirements/reviews/2026-09-16-rt-12-scan-convention-independence.md`).

## Exact query run

Seeded overlay session id: `00000000-0000-4000-8000-0000000000e3`
Seeded token fingerprint (sha256 hex of the fixed string `rt12-scan-explain-capture-token`): `996f081c68aca804f4527dbfda101857424ee6d70113a181eeaf938d623fcd20`
Seeded channel id: `00000000-0000-4000-8000-0000000000e2`; one alert queue, one queue binding, one alert event with a resolvable `ttsAudioArtifactId`, one matching `alert_tts_audio` row, one `event_outbox` row, and one `event_outbox_deliveries` row in status `ready` — the minimum RT-12's task command asked this artefact to seed ("a seeded overlay session, a token fingerprint and at least one ready delivery").

```sql
select set_config('app.overlay_session_id', '00000000-0000-4000-8000-0000000000e3', false);

EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM app_private.get_overlay_events('00000000-0000-4000-8000-0000000000e3'::uuid, null::timestamptz, null::uuid, 50);
```

query_hash: `9105687c2684d4d7a92aaf6eeb8c2319822c4975e3aa44bf4c1f493f776c055f`

Computed by extracting the exact text from the `create function app_private.get_overlay_events(` line through the terminating `$$;` line (inclusive) out of `packages/db/migrations/0127_v1_rt02_overlay_events_artifact_column.sql` as it exists at capture time, then `sha256sum`-ing that extracted text verbatim (UTF-8, including original newlines/whitespace). This is the identical extraction `packages/db/explain-plans/check-plans.mjs` re-runs against the migration file's CURRENT contents on every check; a hash mismatch means the function body changed since this artifact was captured and the plan needs re-verification. **Note:** 0127's definition line is `create function app_private.get_overlay_events(` — no `or replace` — because PostgreSQL requires a `DROP FUNCTION` + `CREATE FUNCTION` to change OUT columns (see this migration's own header comment, and the precedent it cites, `0113_v1_l14_public_profile_projection_minimization.sql`). `check-plans.mjs`'s extraction regex previously matched only `^create or replace function `; it has been widened to `^create (?:or replace )?function ` so this artefact (and any future dropped-and-recreated function) is checkable. Every other existing artefact's migration line still starts with `create or replace function `, so this change does not alter any of their recorded hashes.

captured_at: 2026-09-16T07:36:52Z
postgres_version: postgres:16-alpine (PostgreSQL 16.14 on aarch64-unknown-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit)

This EXPLAIN was captured against an unseeded/minimally-seeded local database (a handful of synthetic rows), not FULL-PRODUCT-DEFINITION.md §37.4's production-scale dataset (500 channels / 2,000,000 payments / 5,000,000 alert events / 200,000 supporter identities). It is a plan-shape change detector only — proof that the query still resolves to the same kind of plan (index scan vs. sequential scan) as when it was last captured — and it is NOT evidence that any §19.4 performance budget is met at production scale.

## Plan shape

Wrapper call: opaque `Function Scan on get_overlay_events` (security definer, never inlined — same reason all fifteen other artefacts in this directory are opaque at the wrapper level; see `goal.explain.md`'s "Correction to the RT-12 task brief's premise" for the `inline_function()`/`prosecdef` citation). Unwrapped body: `Limit -> Sort -> Result(One-Time Filter) -> Nested Loop Left Join` chain, bottoming out in `Index Scan on alert_queues` (via a seq scan on the tiny seeded table — see note below), `Index Scan using event_outbox_deliveries_outbox_id_queue_id_key`, `Index Only Scan using event_outbox_pkey`, `Index Scan using overlay_sessions_pkey`, `Index Scan using alert_events_pkey`, `Index Scan using channel_configs_pkey`, `Index Scan using alert_tts_audio_pkey`, and `Index Scan Backward using channel_entitlement_versions_pkey` for the lateral tier lookup — fully resolved, **no opaque inner Function Scan node**.

This differs from `goal.explain.md`, `hype.explain.md`, `leaderboard.explain.md` and `top-supporters.explain.md`, where an inner `security definer` PL/pgSQL helper (`channel_leaderboard`, `hype_mode_state`) stayed opaque even unwrapped. `get_overlay_events`'s two inner helper calls — `app_private.current_overlay_session_id()` and `app_private.delivery_dispatch_allowed(uuid, bigint)` — are both `language sql stable` **without** `security definer` (see `packages/db/migrations/0002_v1_security_rls_archive.sql:40` and `packages/db/migrations/0062_v1_l03_l05_queue_policy_enforcement.sql:55`), so the planner inlines them: `current_overlay_session_id()` becomes the `One-Time Filter` on the `Result` node, and `delivery_dispatch_allowed(...)` becomes part of the `Filter:` clause on the `event_outbox_deliveries` index scan, rather than a separate `Function Scan` node.

`Seq Scan on alert_queues queue` in the unwrapped plan is a genuine sequential scan, not an artefact of inlining — `alert_queues` has no index on `(closed_at, is_paused)` and this local database has exactly one row in it, so the planner correctly prefers a seq scan over an index scan at this row count. This is not evidence about the scan choice at production scale (hundreds of thousands of queue rows); a re-capture against a larger seeded `alert_queues` table would be needed to see whether an index becomes worthwhile there, and this artefact does not claim that either way.

## Raw EXPLAIN output — literal function-call query (as specified by the RT-12 task text)

```
Function Scan on get_overlay_events  (cost=0.25..10.25 rows=1000 width=168) (actual time=4.360..4.360 rows=1 loops=1)
  Buffers: shared hit=1494 read=2
Planning Time: 0.011 ms
Execution Time: 4.388 ms
```

## Raw EXPLAIN output — supplementary: function body unwrapped, parameters substituted with the same seeded literal values

This is the real join/scan plan for the SQL text covered by `query_hash` above (the function body, not the wrapper call).

```
Limit  (cost=59.98..59.99 rows=1 width=184) (actual time=1.091..1.093 rows=1 loops=1)
  Buffers: shared hit=152
  ->  Sort  (cost=59.98..59.99 rows=1 width=184) (actual time=1.090..1.091 rows=1 loops=1)
        Sort Key: delivery.created_at, delivery.id
        Sort Method: quicksort  Memory: 26kB
        Buffers: shared hit=152
        ->  Result  (cost=1.30..59.97 rows=1 width=184) (actual time=1.048..1.051 rows=1 loops=1)
              One-Time Filter: ('00000000-0000-4000-8000-0000000000e3'::uuid = app_private.current_overlay_session_id())
              Buffers: shared hit=146
              ->  Nested Loop Left Join  (cost=1.30..59.94 rows=1 width=312) (actual time=0.944..0.946 rows=1 loops=1)
                    Buffers: shared hit=140
                    ->  Nested Loop Left Join  (cost=0.90..53.51 rows=1 width=296) (actual time=0.938..0.940 rows=1 loops=1)
                          Buffers: shared hit=138
                          ->  Nested Loop Left Join  (cost=0.74..53.15 rows=1 width=276) (actual time=0.893..0.895 rows=1 loops=1)
                                Join Filter: (config.version = delivery.config_snapshot_version)
                                Buffers: shared hit=136
                                ->  Nested Loop  (cost=0.59..52.72 rows=1 width=244) (actual time=0.890..0.892 rows=1 loops=1)
                                      Join Filter: (session.channel_id = event.channel_id)
                                      Buffers: shared hit=134
                                      ->  Nested Loop  (cost=0.44..44.54 rows=1 width=180) (actual time=0.887..0.888 rows=1 loops=1)
                                            Buffers: shared hit=132
                                            ->  Nested Loop  (cost=0.29..36.36 rows=1 width=164) (actual time=0.881..0.882 rows=1 loops=1)
                                                  Buffers: shared hit=130
                                                  ->  Nested Loop  (cost=0.14..28.17 rows=1 width=180) (actual time=0.873..0.873 rows=1 loops=1)
                                                        Buffers: shared hit=128
                                                        ->  Seq Scan on alert_queues queue  (cost=0.00..14.10 rows=1 width=24) (actual time=0.007..0.007 rows=1 loops=1)
                                                              Filter: ((closed_at IS NULL) AND (NOT is_paused))
                                                              Buffers: shared hit=1
                                                        ->  Index Scan using event_outbox_deliveries_outbox_id_queue_id_key on event_outbox_deliveries delivery  (cost=0.14..14.06 rows=1 width=172) (actual time=0.864..0.864 rows=1 loops=1)
                                                              Index Cond: (queue_id = queue.id)
                                                              Filter: ((status = ANY ('{ready,displayed}'::text[])) AND app_private.delivery_dispatch_allowed(event_id, config_snapshot_version))
                                                              Buffers: shared hit=127
                                                  ->  Index Only Scan using event_outbox_pkey on event_outbox outbox  (cost=0.15..8.17 rows=1 width=16) (actual time=0.007..0.007 rows=1 loops=1)
                                                        Index Cond: (id = delivery.outbox_id)
                                                        Heap Fetches: 1
                                                        Buffers: shared hit=2
                                            ->  Index Scan using overlay_sessions_pkey on overlay_sessions session  (cost=0.15..8.17 rows=1 width=16) (actual time=0.005..0.005 rows=1 loops=1)
                                                  Index Cond: (id = '00000000-0000-4000-8000-0000000000e3'::uuid)
                                                  Filter: ((revoked_at IS NULL) AND (expires_at > CURRENT_TIMESTAMP))
                                                  Buffers: shared hit=2
                                      ->  Index Scan using alert_events_pkey on alert_events event  (cost=0.15..8.17 rows=1 width=96) (actual time=0.002..0.002 rows=1 loops=1)
                                            Index Cond: (id = delivery.event_id)
                                            Buffers: shared hit=2
                                ->  Index Scan using channel_configs_pkey on channel_configs config  (cost=0.15..0.38 rows=4 width=56) (actual time=0.003..0.003 rows=0 loops=1)
                                      Index Cond: (channel_id = event.channel_id)
                                      Buffers: shared hit=2
                          ->  Index Scan using alert_tts_audio_pkey on alert_tts_audio artifact  (cost=0.16..0.36 rows=1 width=20) (actual time=0.006..0.006 rows=1 loops=1)
                                Index Cond: (id = CASE WHEN ((event.payload ->> 'ttsAudioArtifactId'::text) ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'::text) THEN ((event.payload ->> 'ttsAudioArtifactId'::text))::uuid ELSE NULL::uuid END)
                                Buffers: shared hit=2
                    ->  Limit  (cost=0.15..6.17 rows=1 width=40) (actual time=0.004..0.005 rows=0 loops=1)
                          Buffers: shared hit=2
                          ->  Index Scan Backward using channel_entitlement_versions_pkey on channel_entitlement_versions entitlement  (cost=0.15..12.18 rows=2 width=40) (actual time=0.004..0.004 rows=0 loops=1)
                                Index Cond: (channel_id = event.channel_id)
                                Buffers: shared hit=2
Planning:
  Buffers: shared hit=639
Planning Time: 2.404 ms
Execution Time: 1.240 ms
```
