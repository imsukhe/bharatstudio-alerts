# overlay-events — EXPLAIN plan artifact (RT-12)

Function: `app_private.get_overlay_events(uuid, integer)`
Defined at: `packages/db/migrations/0137_v1_rt01_overlay_events_cursor_parameters.sql:47` (block spans lines 47-102)

query_hash: `0bce4b749ea1503609139d4a3ab1204802ebdc6bfc4a3390a7b9a95c42e2477b`

This is the alert stream itself — the query the overlay's SSE replay runs on every wake, for every overlay session, in `apps/api/src/db/overlay-store.ts`'s `replayRaw`. It is not named `list_overlay_*` (RT-02/0127 dropped and recreated it as `get_overlay_events` to add the `tts_audio_artifact_id` output column — PostgreSQL does not allow `CREATE OR REPLACE FUNCTION` to change a function's OUT columns), which is exactly why the naming-convention scan could not nominate it and why this task exists (`bharatstudio-requirements/reviews/2026-09-16-rt-12-scan-convention-independence.md`).

## Exact query run

Seeded overlay session id: `00000000-0000-4000-8000-00000000b031`
Seeded token fingerprint (sha256 hex of the fixed string `rt12-scan-explain-capture-token`): `996f081c68aca804f4527dbfda101857424ee6d70113a181eeaf938d623fcd20`
Seeded channel id: `00000000-0000-4000-8000-0000000000e2`; one alert queue, one queue binding, one alert event with a resolvable `ttsAudioArtifactId`, one matching `alert_tts_audio` row, one `event_outbox` row, and one `event_outbox_deliveries` row in status `ready` — the minimum RT-12's task command asked this artefact to seed ("a seeded overlay session, a token fingerprint and at least one ready delivery").

```sql
select set_config('app.overlay_session_id', '00000000-0000-4000-8000-0000000000e3', false);

EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM app_private.get_overlay_events('00000000-0000-4000-8000-0000000000e3'::uuid, null::timestamptz, null::uuid, 50);
```
Function Scan on get_overlay_events  (cost=0.25..10.25 rows=1000 width=168) (actual time=4.707..4.708 rows=2 loops=1)
  Buffers: shared hit=1546
Planning Time: 0.016 ms
Execution Time: 4.740 ms
```
Function Scan on get_overlay_events  (cost=0.25..10.25 rows=1000 width=168) (actual time=4.360..4.360 rows=1 loops=1)
  Buffers: shared hit=1494 read=2
Planning Time: 0.011 ms
Execution Time: 4.388 ms
```
Limit  (cost=60.00..60.00 rows=1 width=184) (actual time=0.970..0.971 rows=2 loops=1)
  Buffers: shared hit=187
  ->  Sort  (cost=60.00..60.00 rows=1 width=184) (actual time=0.969..0.970 rows=2 loops=1)
        Sort Key: delivery.created_at, delivery.id
        Sort Method: quicksort  Memory: 27kB
        Buffers: shared hit=187
        ->  Result  (cost=1.30..59.99 rows=1 width=184) (actual time=0.863..0.952 rows=2 loops=1)
              One-Time Filter: ('00000000-0000-4000-8000-00000000b031'::uuid = app_private.current_overlay_session_id())
              Buffers: shared hit=181
              ->  Nested Loop Left Join  (cost=1.30..59.96 rows=1 width=312) (actual time=0.790..0.872 rows=2 loops=1)
                    Buffers: shared hit=175
                    ->  Nested Loop Left Join  (cost=0.90..53.52 rows=1 width=296) (actual time=0.786..0.866 rows=2 loops=1)
                          Buffers: shared hit=171
                          ->  Nested Loop Left Join  (cost=0.74..53.17 rows=1 width=276) (actual time=0.749..0.828 rows=2 loops=1)
                                Join Filter: (config.version = delivery.config_snapshot_version)
                                Buffers: shared hit=169
                                ->  Nested Loop  (cost=0.59..52.72 rows=1 width=244) (actual time=0.746..0.825 rows=2 loops=1)
                                      Join Filter: (session.channel_id = event.channel_id)
                                      Rows Removed by Join Filter: 1
                                      Buffers: shared hit=165
                                      ->  Nested Loop  (cost=0.44..44.54 rows=1 width=180) (actual time=0.703..0.819 rows=3 loops=1)
                                            Buffers: shared hit=159
                                            ->  Nested Loop  (cost=0.29..36.36 rows=1 width=164) (actual time=0.699..0.813 rows=3 loops=1)
                                                  Buffers: shared hit=153
                                                  ->  Nested Loop  (cost=0.14..28.17 rows=1 width=180) (actual time=0.692..0.804 rows=3 loops=1)
                                                        Buffers: shared hit=147
                                                        ->  Seq Scan on alert_queues queue  (cost=0.00..14.10 rows=1 width=24) (actual time=0.005..0.006 rows=4 loops=1)
                                                              Filter: ((closed_at IS NULL) AND (NOT is_paused))
                                                              Rows Removed by Filter: 2
                                                              Buffers: shared hit=1
                                                        ->  Index Scan using event_outbox_deliveries_outbox_id_queue_id_key on event_outbox_deliveries delivery  (cost=0.14..14.06 rows=1 width=172) (actual time=0.180..0.199 rows=1 loops=4)
                                                              Index Cond: (queue_id = queue.id)
                                                              Filter: ((status = ANY ('{ready,displayed}'::text[])) AND app_private.delivery_dispatch_allowed(event_id, config_snapshot_version))
                                                              Rows Removed by Filter: 0
                                                              Buffers: shared hit=146
                                                  ->  Index Only Scan using event_outbox_pkey on event_outbox outbox  (cost=0.15..8.17 rows=1 width=16) (actual time=0.003..0.003 rows=1 loops=3)
                                                        Index Cond: (id = delivery.outbox_id)
                                                        Heap Fetches: 3
                                                        Buffers: shared hit=6
                                            ->  Index Scan using overlay_sessions_pkey on overlay_sessions session  (cost=0.15..8.17 rows=1 width=16) (actual time=0.002..0.002 rows=1 loops=3)
                                                  Index Cond: (id = '00000000-0000-4000-8000-00000000b031'::uuid)
                                                  Filter: ((revoked_at IS NULL) AND (expires_at > CURRENT_TIMESTAMP))
                                                  Buffers: shared hit=6
                                      ->  Index Scan using alert_events_pkey on alert_events event  (cost=0.15..8.17 rows=1 width=96) (actual time=0.001..0.001 rows=1 loops=3)
                                            Index Cond: (id = delivery.event_id)
                                            Buffers: shared hit=6
                                ->  Index Scan using channel_configs_pkey on channel_configs config  (cost=0.15..0.40 rows=4 width=56) (actual time=0.001..0.001 rows=1 loops=2)
                                      Index Cond: (channel_id = event.channel_id)
                                      Buffers: shared hit=4
                          ->  Index Scan using alert_tts_audio_pkey on alert_tts_audio artifact  (cost=0.16..0.36 rows=1 width=20) (actual time=0.002..0.002 rows=0 loops=2)
                                Index Cond: (id = CASE WHEN ((event.payload ->> 'ttsAudioArtifactId'::text) ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'::text) THEN ((event.payload ->> 'ttsAudioArtifactId'::text))::uuid ELSE NULL::uuid END)
                                Buffers: shared hit=2
                    ->  Limit  (cost=0.15..6.17 rows=1 width=40) (actual time=0.002..0.002 rows=1 loops=2)
                          Buffers: shared hit=4
                          ->  Index Scan Backward using channel_entitlement_versions_pkey on channel_entitlement_versions entitlement  (cost=0.15..12.18 rows=2 width=40) (actual time=0.002..0.002 rows=1 loops=2)
                                Index Cond: (channel_id = event.channel_id)
                                Buffers: shared hit=4
Planning:
  Buffers: shared hit=660
Planning Time: 2.291 ms
Execution Time: 1.085 ms
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


## Re-capture, 2026-09-16 — migration `0137`

Migration `0137` removed `get_overlay_events`'s two inert cursor parameters, which changed
the function's source text and therefore its `query_hash`. **That mismatch is exactly the
signal `check-plans.mjs` exists to raise: "the function body changed since this artifact was
captured and the plan needs re-verification."** The first thing done here was to recompute the
hash so the check passed again — which silenced the detector instead of answering it. Recorded
because it is the mistake, not the fix: a change-detector you quiet without re-measuring is
worse than no detector, because it now certifies something nobody checked.

Both plans above were then genuinely re-measured against `0137` on a fresh
`postgres:16-alpine` database with every migration `0001`–`0137` applied.

**The seed changed, deliberately, and this is an improvement.** The original capture used a
bespoke fixture (session `…0000e3`, a token fingerprint of a fixed string) that existed only in
the ad-hoc process that produced it and was never committed, so it could not be reproduced. This
capture seeds from `packages/db/tests/rt02_overlay_events_artifact_column.sql`, a maintained
fixture in the suite, so any future re-capture runs the same seed by construction. The seed is
larger by two rows (`rows=2` rather than `rows=1`, four alert queues rather than one), so
absolute buffer counts and timings are **not** comparable with the previous capture and no
comparison is drawn from them.

**What is comparable, and what it shows:** the plan SHAPE is unchanged. The wrapper is still an
opaque `Function Scan` (security definer, never inlined). The unwrapped body still resolves to
`Limit → Sort → Result (One-Time Filter) → Nested Loop Left Join`, still inlines
`current_overlay_session_id()` into the one-time filter, and still reaches
`event_outbox_deliveries` through
`event_outbox_deliveries_outbox_id_queue_id_key` rather than a sequential scan. `Seq Scan on
alert_queues` is still present and still expected at this row count — see the note above; that
table has no index on `(closed_at, is_paused)` and this database holds four rows in it.

Removing the parameters could not have changed the plan — no predicate, join, ordering, limit or
returned column referenced them, and `0137`'s body is byte-identical to `0127`'s. That was the
prediction; these captures are the measurement, and they are recorded because a prediction is not
evidence.

Capture is reproducible: roles, then `packages/db/migrations/*.sql` in order, then
`packages/db/tests/fixtures/00_base_world.sql`, then
`packages/db/tests/rt02_overlay_events_artifact_column.sql`, then `EXPLAIN (ANALYZE, BUFFERS)`
of the wrapper call as `bsa_app`, and of the unwrapped body as the owner (the unwrapped form
touches base tables directly, which only the security-definer wrapper may do as `bsa_app`).

Still not production evidence. Same limitation as the original capture: a minimal local seed,
a plan-shape change detector only, and no claim about any §19.4 budget at production scale.
