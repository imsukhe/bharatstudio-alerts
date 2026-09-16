# vote — EXPLAIN plan artifact (RT-12)

Function: `app_private.list_overlay_vote_tally(uuid, text, uuid)`
Defined at: `packages/db/migrations/0105_v1_l16_interaction_definitions_and_widgets.sql:567` (block spans lines 567-606)

## Exact query run

Seeded overlay session id: `00000000-0000-0000-0000-000000000003`
Seeded token fingerprint (sha256 hex of the fixed string `rt12-explain-capture-token`): `aca8464c4445892c4627b19f1335ae66b84c87976e994d973b1c15769cf3f56d`

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM app_private.list_overlay_vote_tally('00000000-0000-0000-0000-000000000003'::uuid, 'aca8464c4445892c4627b19f1335ae66b84c87976e994d973b1c15769cf3f56d', '00000000-0000-0000-0000-00000000000a'::uuid);
```

query_hash: `1efe3af226d4c9ee5eb62aed0f68dc67af5174dce287695a89fa6ddc337798ec`

Computed by extracting the exact text from the `create or replace function app_private.list_overlay_vote_tally(` line through the terminating `$$;` line (inclusive) out of `packages/db/migrations/0105_v1_l16_interaction_definitions_and_widgets.sql` as it exists at capture time, then `sha256sum`-ing that extracted text verbatim (UTF-8, including original newlines/whitespace). This is the identical extraction `packages/db/explain-plans/check-plans.mjs` re-runs against the migration file's CURRENT contents on every check; a hash mismatch means the function body changed since this artifact was captured and the plan needs re-verification.

captured_at: 2026-09-16T04:32:22Z
postgres_version: postgres:16-alpine (PostgreSQL 16.14 on aarch64-unknown-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit)

This EXPLAIN was captured against an unseeded/minimally-seeded local database (a handful of synthetic rows), not FULL-PRODUCT-DEFINITION.md §37.4's production-scale dataset (500 channels / 2,000,000 payments / 5,000,000 alert events / 200,000 supporter identities). It is a plan-shape change detector only — proof that the query still resolves to the same kind of plan (index scan vs. sequential scan) as when it was last captured — and it is NOT evidence that any §19.4 performance budget is met at production scale.

## Plan shape

Wrapper call: opaque `Function Scan on list_overlay_vote_tally` (security definer, never inlined). Unwrapped body: CTE plan built entirely from real scans — `Index Scan using overlay_sessions_pkey on overlay_sessions`, `Index Scan using interaction_definitions_pkey on interaction_definitions`, `Bitmap Heap/Index Scan on interaction_vote_options`, `Index Scan using interaction_vote_records_tally_idx on interaction_vote_records` — fully resolved, no opaque sub-nodes.

**Correction to the RT-12 task brief's premise:** the brief assumed that because these ten functions are `language sql stable`, Postgres would inline them into the outer plan on `EXPLAIN SELECT * FROM app_private.<fn>(...)`, exposing the real join/scan plan directly. That assumption does not hold here: all ten functions (and the two `security definer` helpers `app_private.channel_leaderboard` and, transitively, `app_private.hype_mode_state`'s caller) are additionally declared `security definer`, and PostgreSQL's planner never inlines a SECURITY DEFINER SQL function regardless of STABLE/IMMUTABLE (see `inline_function()` in `src/backend/optimizer/util/clauses.c`: `if (funcform->prosecdef) goto fail;`) — inlining a security-definer function would let its body execute with the *caller's* privileges/search_path instead of the definer's, which Postgres refuses to risk. The literal command from the RT-12 task text therefore reliably produces an opaque `Function Scan on <fn>` node with no visible join/scan detail, on every Postgres version, not just this capture. To still get the real join/scan plan-shape evidence RT-12 actually wants, this artifact captures **both**: (1) the literal function-call EXPLAIN exactly as the task specified (reproducible, verbatim), and (2) a supplementary "unwrapped" EXPLAIN of the function's own body with its parameters substituted by literal values — the same SQL text this function's `query_hash` covers — which Postgres plans and executes as an ordinary query and which therefore surfaces the real index/seq scan nodes. Where the unwrapped body itself calls another `security definer` function (`channel_leaderboard`, `hype_mode_state`), that inner call remains its own opaque `Function Scan` node for the same reason — noted per widget below.

## Raw EXPLAIN output — literal function-call query (as specified by the RT-12 task text)

```
Function Scan on list_overlay_vote_tally  (cost=0.25..10.25 rows=1000 width=105) (actual time=2.169..2.169 rows=2 loops=1)
  Buffers: shared hit=802
Planning Time: 0.032 ms
Execution Time: 2.202 ms
```

## Raw EXPLAIN output — supplementary: function body unwrapped, parameters substituted with the same seeded literal values

This is the real join/scan plan for the SQL text covered by `query_hash` above (the function body, not the wrapper call).

```
Sort  (cost=42.90..42.90 rows=1 width=105) (actual time=0.066..0.068 rows=2 loops=1)
  Sort Key: t.vote_count DESC, t.option_key
  Sort Method: quicksort  Memory: 25kB
  Buffers: shared hit=18
  CTE scoped_channel
    ->  Index Scan using overlay_sessions_pkey on overlay_sessions session  (cost=0.15..8.18 rows=1 width=16) (actual time=0.008..0.009 rows=1 loops=1)
          Index Cond: (id = '00000000-0000-0000-0000-000000000003'::uuid)
          Filter: ((revoked_at IS NULL) AND (token_fingerprint = 'aca8464c4445892c4627b19f1335ae66b84c87976e994d973b1c15769cf3f56d'::text) AND (expires_at > CURRENT_TIMESTAMP))
          Buffers: shared hit=2
  CTE tallies
    ->  GroupAggregate  (cost=26.37..26.39 rows=1 width=72) (actual time=0.041..0.042 rows=2 loops=1)
          Group Key: opt.option_key, opt.label
          Buffers: shared hit=10
          ->  Sort  (cost=26.37..26.37 rows=1 width=80) (actual time=0.038..0.039 rows=3 loops=1)
                Sort Key: opt.option_key, opt.label
                Sort Method: quicksort  Memory: 25kB
                Buffers: shared hit=10
                ->  Nested Loop Left Join  (cost=4.47..26.36 rows=1 width=80) (actual time=0.029..0.032 rows=3 loops=1)
                      Buffers: shared hit=10
                      ->  Nested Loop  (cost=4.32..19.51 rows=1 width=80) (actual time=0.020..0.021 rows=2 loops=1)
                            Buffers: shared hit=6
                            ->  Nested Loop  (cost=0.15..8.20 rows=1 width=16) (actual time=0.016..0.017 rows=1 loops=1)
                                  Join Filter: (sc.channel_id = def.channel_id)
                                  Buffers: shared hit=4
                                  ->  Index Scan using interaction_definitions_pkey on interaction_definitions def  (cost=0.15..8.17 rows=1 width=32) (actual time=0.005..0.006 rows=1 loops=1)
                                        Index Cond: (id = '00000000-0000-0000-0000-00000000000a'::uuid)
                                        Buffers: shared hit=2
                                  ->  CTE Scan on scoped_channel sc  (cost=0.00..0.02 rows=1 width=16) (actual time=0.009..0.009 rows=1 loops=1)
                                        Buffers: shared hit=2
                            ->  Bitmap Heap Scan on interaction_vote_options opt  (cost=4.17..11.28 rows=3 width=80) (actual time=0.003..0.003 rows=2 loops=1)
                                  Recheck Cond: (interaction_definition_id = '00000000-0000-0000-0000-00000000000a'::uuid)
                                  Heap Blocks: exact=1
                                  Buffers: shared hit=2
                                  ->  Bitmap Index Scan on interaction_vote_options_interaction_definition_id_option_k_key  (cost=0.00..4.17 rows=3 width=0) (actual time=0.002..0.002 rows=2 loops=1)
                                        Index Cond: (interaction_definition_id = '00000000-0000-0000-0000-00000000000a'::uuid)
                                        Buffers: shared hit=1
                      ->  Index Scan using interaction_vote_records_tally_idx on interaction_vote_records rec  (cost=0.15..6.84 rows=1 width=64) (actual time=0.004..0.004 rows=2 loops=2)
                            Index Cond: ((interaction_definition_id = '00000000-0000-0000-0000-00000000000a'::uuid) AND (option_key = opt.option_key))
                            Buffers: shared hit=4
  CTE is_closed
    ->  Nested Loop  (cost=0.15..8.20 rows=1 width=1) (actual time=0.004..0.004 rows=1 loops=1)
          Join Filter: (sc_1.channel_id = def_1.channel_id)
          Buffers: shared hit=2
          ->  Index Scan using interaction_definitions_pkey on interaction_definitions def_1  (cost=0.15..8.17 rows=1 width=24) (actual time=0.003..0.003 rows=1 loops=1)
                Index Cond: (id = '00000000-0000-0000-0000-00000000000a'::uuid)
                Buffers: shared hit=2
          ->  CTE Scan on scoped_channel sc_1  (cost=0.00..0.02 rows=1 width=16) (actual time=0.000..0.000 rows=1 loops=1)
  InitPlan 4 (returns $4)
    ->  CTE Scan on is_closed  (cost=0.00..0.02 rows=1 width=1) (actual time=0.004..0.004 rows=1 loops=1)
          Buffers: shared hit=2
  InitPlan 5 (returns $5)
    ->  CTE Scan on is_closed is_closed_1  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.000 rows=1 loops=1)
  InitPlan 6 (returns $6)
    ->  CTE Scan on tallies  (cost=0.00..0.02 rows=1 width=0) (never executed)
          Filter: (vote_count > 0)
  InitPlan 7 (returns $7)
    ->  Subquery Scan on winner  (cost=0.03..0.05 rows=1 width=32) (never executed)
          ->  Limit  (cost=0.03..0.04 rows=1 width=40) (never executed)
                ->  Sort  (cost=0.03..0.04 rows=1 width=40) (never executed)
                      Sort Key: tallies_1.vote_count DESC, tallies_1.option_key
                      ->  CTE Scan on tallies tallies_1  (cost=0.00..0.02 rows=1 width=40) (never executed)
  ->  CTE Scan on tallies t  (cost=0.00..0.02 rows=1 width=105) (actual time=0.048..0.049 rows=2 loops=1)
        Buffers: shared hit=12
Planning:
  Buffers: shared hit=376
Planning Time: 0.965 ms
Execution Time: 0.154 ms
```
