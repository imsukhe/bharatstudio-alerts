# paid-vote — EXPLAIN plan artifact (RT-12)

Function: `app_private.list_overlay_paid_vote_tally(uuid, text, uuid)`
Defined at: `packages/db/migrations/0108_v1_l16_paid_votes_and_missing_widgets.sql:244` (block spans lines 244-305)

## Exact query run

Seeded overlay session id: `00000000-0000-0000-0000-000000000003`
Seeded token fingerprint (sha256 hex of the fixed string `rt12-explain-capture-token`): `aca8464c4445892c4627b19f1335ae66b84c87976e994d973b1c15769cf3f56d`

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM app_private.list_overlay_paid_vote_tally('00000000-0000-0000-0000-000000000003'::uuid, 'aca8464c4445892c4627b19f1335ae66b84c87976e994d973b1c15769cf3f56d', '00000000-0000-0000-0000-00000000000b'::uuid);
```

query_hash: `60bb3e48d18dcae9c7123e513412efbc48f3007744a0e8b39bb161e8676f7b54`

Computed by extracting the exact text from the `create or replace function app_private.list_overlay_paid_vote_tally(` line through the terminating `$$;` line (inclusive) out of `packages/db/migrations/0108_v1_l16_paid_votes_and_missing_widgets.sql` as it exists at capture time, then `sha256sum`-ing that extracted text verbatim (UTF-8, including original newlines/whitespace). This is the identical extraction `packages/db/explain-plans/check-plans.mjs` re-runs against the migration file's CURRENT contents on every check; a hash mismatch means the function body changed since this artifact was captured and the plan needs re-verification.

captured_at: 2026-09-16T04:32:22Z
postgres_version: postgres:16-alpine (PostgreSQL 16.14 on aarch64-unknown-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit)

This EXPLAIN was captured against an unseeded/minimally-seeded local database (a handful of synthetic rows), not FULL-PRODUCT-DEFINITION.md §37.4's production-scale dataset (500 channels / 2,000,000 payments / 5,000,000 alert events / 200,000 supporter identities). It is a plan-shape change detector only — proof that the query still resolves to the same kind of plan (index scan vs. sequential scan) as when it was last captured — and it is NOT evidence that any §19.4 performance budget is met at production scale.

## Plan shape

Wrapper call: opaque `Function Scan on list_overlay_paid_vote_tally` (security definer, never inlined). Unwrapped body: CTE plan built entirely from real scans — `Index Scan using overlay_sessions_pkey`, `Index Scan using payment_order_intents_idempotency_unique`, `Index Scan using vote_payment_tags_channel_id_environment_idempotency_key_key`, `Index Scan using payments_order_account_idx`, `Bitmap Heap/Index Scan on interaction_vote_options`, `Seq Scan on refunds` (3 synthetic rows, below the index-scan threshold) — fully resolved, no opaque sub-nodes.

**Correction to the RT-12 task brief's premise:** the brief assumed that because these ten functions are `language sql stable`, Postgres would inline them into the outer plan on `EXPLAIN SELECT * FROM app_private.<fn>(...)`, exposing the real join/scan plan directly. That assumption does not hold here: all ten functions (and the two `security definer` helpers `app_private.channel_leaderboard` and, transitively, `app_private.hype_mode_state`'s caller) are additionally declared `security definer`, and PostgreSQL's planner never inlines a SECURITY DEFINER SQL function regardless of STABLE/IMMUTABLE (see `inline_function()` in `src/backend/optimizer/util/clauses.c`: `if (funcform->prosecdef) goto fail;`) — inlining a security-definer function would let its body execute with the *caller's* privileges/search_path instead of the definer's, which Postgres refuses to risk. The literal command from the RT-12 task text therefore reliably produces an opaque `Function Scan on <fn>` node with no visible join/scan detail, on every Postgres version, not just this capture. To still get the real join/scan plan-shape evidence RT-12 actually wants, this artifact captures **both**: (1) the literal function-call EXPLAIN exactly as the task specified (reproducible, verbatim), and (2) a supplementary "unwrapped" EXPLAIN of the function's own body with its parameters substituted by literal values — the same SQL text this function's `query_hash` covers — which Postgres plans and executes as an ordinary query and which therefore surfaces the real index/seq scan nodes. Where the unwrapped body itself calls another `security definer` function (`channel_leaderboard`, `hype_mode_state`), that inner call remains its own opaque `Function Scan` node for the same reason — noted per widget below.

## Raw EXPLAIN output — literal function-call query (as specified by the RT-12 task text)

```
Function Scan on list_overlay_paid_vote_tally  (cost=0.25..10.25 rows=1000 width=105) (actual time=4.446..4.446 rows=2 loops=1)
  Buffers: shared hit=1472
Planning Time: 0.029 ms
Execution Time: 4.489 ms
```

## Raw EXPLAIN output — supplementary: function body unwrapped, parameters substituted with the same seeded literal values

This is the real join/scan plan for the SQL text covered by `query_hash` above (the function body, not the wrapper call).

```
Sort  (cost=62.34..62.34 rows=1 width=129) (actual time=0.093..0.095 rows=2 loops=1)
  Sort Key: t.amount_paise DESC, t.option_key
  Sort Method: quicksort  Memory: 25kB
  Buffers: shared hit=20
  CTE scoped_channel
    ->  Index Scan using overlay_sessions_pkey on overlay_sessions session  (cost=0.15..8.18 rows=1 width=16) (actual time=0.007..0.008 rows=1 loops=1)
          Index Cond: (id = '00000000-0000-0000-0000-000000000003'::uuid)
          Filter: ((revoked_at IS NULL) AND (token_fingerprint = 'aca8464c4445892c4627b19f1335ae66b84c87976e994d973b1c15769cf3f56d'::text) AND (expires_at > CURRENT_TIMESTAMP))
          Buffers: shared hit=2
  CTE tallies
    ->  GroupAggregate  (cost=41.66..45.83 rows=1 width=96) (actual time=0.074..0.076 rows=2 loops=1)
          Group Key: opt.option_key, opt.label
          Buffers: shared hit=15
          ->  Incremental Sort  (cost=41.66..45.80 rows=2 width=96) (actual time=0.071..0.072 rows=2 loops=1)
                Sort Key: opt.option_key, opt.label
                Presorted Key: opt.option_key
                Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 25kB  Peak Memory: 25kB
                Buffers: shared hit=15
                ->  Nested Loop  (cost=37.59..45.71 rows=1 width=96) (actual time=0.064..0.067 rows=2 loops=1)
                      Buffers: shared hit=15
                      ->  Merge Left Join  (cost=37.44..37.47 rows=3 width=112) (actual time=0.058..0.060 rows=2 loops=1)
                            Merge Cond: (opt.option_key = tag.option_key)
                            Buffers: shared hit=13
                            ->  Sort  (cost=11.31..11.31 rows=3 width=80) (actual time=0.013..0.013 rows=2 loops=1)
                                  Sort Key: opt.option_key
                                  Sort Method: quicksort  Memory: 25kB
                                  Buffers: shared hit=2
                                  ->  Bitmap Heap Scan on interaction_vote_options opt  (cost=4.17..11.28 rows=3 width=80) (actual time=0.005..0.006 rows=2 loops=1)
                                        Recheck Cond: (interaction_definition_id = '00000000-0000-0000-0000-00000000000b'::uuid)
                                        Heap Blocks: exact=1
                                        Buffers: shared hit=2
                                        ->  Bitmap Index Scan on interaction_vote_options_interaction_definition_id_option_k_key  (cost=0.00..4.17 rows=3 width=0) (actual time=0.002..0.002 rows=2 loops=1)
                                              Index Cond: (interaction_definition_id = '00000000-0000-0000-0000-00000000000b'::uuid)
                                              Buffers: shared hit=1
                            ->  Sort  (cost=26.14..26.14 rows=1 width=64) (actual time=0.044..0.044 rows=1 loops=1)
                                  Sort Key: tag.option_key
                                  Sort Method: quicksort  Memory: 25kB
                                  Buffers: shared hit=11
                                  ->  Nested Loop Left Join  (cost=17.34..26.13 rows=1 width=64) (actual time=0.038..0.039 rows=1 loops=1)
                                        Join Filter: (refund.payment_id = payment.id)
                                        Buffers: shared hit=11
                                        ->  Nested Loop  (cost=0.44..9.12 rows=1 width=56) (actual time=0.024..0.025 rows=1 loops=1)
                                              Buffers: shared hit=8
                                              ->  Nested Loop  (cost=0.29..8.66 rows=1 width=192) (actual time=0.018..0.019 rows=1 loops=1)
                                                    Join Filter: (tag.channel_id = sc_1.channel_id)
                                                    Buffers: shared hit=6
                                                    ->  Nested Loop  (cost=0.14..8.19 rows=1 width=192) (actual time=0.013..0.013 rows=1 loops=1)
                                                          Buffers: shared hit=4
                                                          ->  CTE Scan on scoped_channel sc_1  (cost=0.00..0.02 rows=1 width=16) (actual time=0.008..0.008 rows=1 loops=1)
                                                                Buffers: shared hit=2
                                                          ->  Index Scan using payment_order_intents_idempotency_unique on payment_order_intents intent  (cost=0.14..8.16 rows=1 width=176) (actual time=0.004..0.004 rows=1 loops=1)
                                                                Index Cond: (channel_id = sc_1.channel_id)
                                                                Buffers: shared hit=2
                                                    ->  Index Scan using vote_payment_tags_channel_id_environment_idempotency_key_key on vote_payment_tags tag  (cost=0.15..0.45 rows=1 width=112) (actual time=0.004..0.004 rows=1 loops=1)
                                                          Index Cond: ((channel_id = intent.channel_id) AND (environment = intent.environment) AND (idempotency_key = intent.idempotency_key))
                                                          Filter: (interaction_definition_id = '00000000-0000-0000-0000-00000000000b'::uuid)
                                                          Buffers: shared hit=2
                                              ->  Index Scan using payments_order_account_idx on payments payment  (cost=0.14..0.45 rows=1 width=152) (actual time=0.006..0.006 rows=1 loops=1)
                                                    Index Cond: ((provider = intent.provider) AND (environment = intent.environment) AND (connected_account_ref = intent.connected_account_ref) AND (provider_order_id = intent.provider_order_id))
                                                    Buffers: shared hit=2
                                        ->  GroupAggregate  (cost=16.90..16.96 rows=3 width=48) (actual time=0.011..0.011 rows=0 loops=1)
                                              Group Key: refund.payment_id
                                              Buffers: shared hit=3
                                              ->  Sort  (cost=16.90..16.91 rows=3 width=24) (actual time=0.011..0.011 rows=0 loops=1)
                                                    Sort Key: refund.payment_id
                                                    Sort Method: quicksort  Memory: 25kB
                                                    Buffers: shared hit=3
                                                    ->  Seq Scan on refunds refund  (cost=0.00..16.88 rows=3 width=24) (actual time=0.001..0.001 rows=0 loops=1)
                                                          Filter: (status = 'processed'::text)
                      ->  Materialize  (cost=0.15..8.20 rows=1 width=16) (actual time=0.003..0.003 rows=1 loops=2)
                            Buffers: shared hit=2
                            ->  Nested Loop  (cost=0.15..8.20 rows=1 width=16) (actual time=0.004..0.005 rows=1 loops=1)
                                  Join Filter: (sc.channel_id = def.channel_id)
                                  Buffers: shared hit=2
                                  ->  Index Scan using interaction_definitions_pkey on interaction_definitions def  (cost=0.15..8.17 rows=1 width=32) (actual time=0.004..0.004 rows=1 loops=1)
                                        Index Cond: (id = '00000000-0000-0000-0000-00000000000b'::uuid)
                                        Buffers: shared hit=2
                                  ->  CTE Scan on scoped_channel sc  (cost=0.00..0.02 rows=1 width=16) (actual time=0.000..0.000 rows=1 loops=1)
  CTE is_closed
    ->  Nested Loop  (cost=0.15..8.20 rows=1 width=1) (actual time=0.004..0.004 rows=1 loops=1)
          Join Filter: (sc_2.channel_id = def_1.channel_id)
          Buffers: shared hit=2
          ->  Index Scan using interaction_definitions_pkey on interaction_definitions def_1  (cost=0.15..8.17 rows=1 width=24) (actual time=0.003..0.003 rows=1 loops=1)
                Index Cond: (id = '00000000-0000-0000-0000-00000000000b'::uuid)
                Buffers: shared hit=2
          ->  CTE Scan on scoped_channel sc_2  (cost=0.00..0.02 rows=1 width=16) (actual time=0.000..0.000 rows=1 loops=1)
  InitPlan 4 (returns $11)
    ->  CTE Scan on is_closed  (cost=0.00..0.02 rows=1 width=1) (actual time=0.004..0.004 rows=1 loops=1)
          Buffers: shared hit=2
  InitPlan 5 (returns $12)
    ->  CTE Scan on is_closed is_closed_1  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.000 rows=1 loops=1)
  InitPlan 6 (returns $13)
    ->  CTE Scan on tallies  (cost=0.00..0.02 rows=1 width=0) (never executed)
          Filter: (amount_paise > '0'::numeric)
  InitPlan 7 (returns $14)
    ->  Subquery Scan on winner  (cost=0.03..0.05 rows=1 width=32) (never executed)
          ->  Limit  (cost=0.03..0.04 rows=1 width=64) (never executed)
                ->  Sort  (cost=0.03..0.04 rows=1 width=64) (never executed)
                      Sort Key: tallies_1.amount_paise DESC, tallies_1.option_key
                      ->  CTE Scan on tallies tallies_1  (cost=0.00..0.02 rows=1 width=64) (never executed)
  ->  CTE Scan on tallies t  (cost=0.00..0.02 rows=1 width=129) (actual time=0.081..0.082 rows=2 loops=1)
        Buffers: shared hit=17
Planning:
  Buffers: shared hit=615
Planning Time: 1.969 ms
Execution Time: 0.233 ms
```
