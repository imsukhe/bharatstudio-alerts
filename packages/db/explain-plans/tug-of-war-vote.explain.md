# tug-of-war-vote — EXPLAIN plan artifact (RT-12; module #3, new in PRF-02 slice 2)

Function: `app_private.list_overlay_tug_of_war_vote(uuid, text)`
Defined at: `packages/db/migrations/0132_v1_prf02_slice2_tug_of_war_vote.sql:56` (block spans lines 56-133)

New function, new in this slice. Captured as part of this task's own work rather than left for a
future slice, per the same "capture the artefact when the query is written" discipline this slice's
RT-12 closure work (§1(a)) establishes for everything else.

## Exact query run

Seeded overlay session id: `00000000-0000-4000-8000-000000009999`
Seeded token fingerprint (sha256 hex of the fixed string `rt12-explain-capture-token-s2`): `e9966f41f78629475fa93f04272c64ee8d2269217afceccb205735c1e27b5595`
Seeded data: one two-option paid `support_vote` definition ("Explain capture tug of war", options
`team-red`/`team-blue`), two captured payments (₹3000 tagged to `team-red`, ₹1000 tagged to
`team-blue`) via `app_private.tag_vote_payment` — the same fixture shape
`packages/db/tests/prf02_slice2_tug_of_war_vote.sql` uses for its correctness assertions.

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM app_private.list_overlay_tug_of_war_vote('00000000-0000-4000-8000-000000009999'::uuid, 'e9966f41f78629475fa93f04272c64ee8d2269217afceccb205735c1e27b5595');
```

query_hash: `9ee100511788e6f66c10a86ef845e84e6d43837febe19d929758ece7c003440b`

Computed by extracting the exact text from the `create or replace function app_private.list_overlay_tug_of_war_vote(` line through the terminating `$$;` line (inclusive) out of `packages/db/migrations/0132_v1_prf02_slice2_tug_of_war_vote.sql` as it exists at capture time, then `sha256sum`-ing that extracted text verbatim (UTF-8, including original newlines/whitespace). This is the identical extraction `packages/db/explain-plans/check-plans.mjs` re-runs against the migration file's CURRENT contents on every check; a hash mismatch means the function body changed since this artifact was captured and the plan needs re-verification.

captured_at: 2026-09-16T00:00:00Z
postgres_version: postgres:16-alpine (PostgreSQL 16.14 on aarch64-unknown-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit)

This EXPLAIN was captured against an unseeded/minimally-seeded local database (one channel, one
two-option paid vote, two tagged payments), not FULL-PRODUCT-DEFINITION.md §37.4's production-scale
dataset (500 channels / 2,000,000 payments / 5,000,000 alert events / 200,000 supporter identities).
It is a plan-shape change detector only — proof that the query still resolves to the same kind of
plan (index scan vs. sequential scan) as when it was last captured — and it is NOT evidence that any
§19.4 performance budget is met at production scale. This task's transparency definition for the Vote
module (reviews/2026-09-16-prf-02-slice-2-implementation.md) is about correctness of derivation, not
about performance; this artifact is the separate, RT-12-required proof that the derivation's query has
a checked-in plan shape at all.

## Plan shape

Wrapper call: opaque `Function Scan on list_overlay_tug_of_war_vote` (security definer, never inlined
— see the correction on every other artifact in this directory, reproduced in full on
`master-canvas-modules-overlay.explain.md`). Unwrapped body: mostly resolved via real index/bitmap
scans (`Index Scan using overlay_sessions_pkey`, `Bitmap Index Scan on
interaction_vote_options_interaction_definition_id_option_k_key` (twice), `Index Scan using
payment_order_intents_idempotency_unique`, `Index Scan using
vote_payment_tags_channel_id_environment_idempotency_key_key`, `Index Scan using
payments_order_account_idx`, `Index Scan using interaction_definitions_pkey`) with one **`Seq Scan on
interaction_definitions`** (the `active_definition` CTE's eligibility filter — `interaction_type`,
`is_enabled`, `config->>'votingMode'`, and the two-option count are not indexed columns) and one
**`Seq Scan on refunds`** — both honest at this seed size (a handful of rows total across each table),
not evidence of production-size behaviour, exactly the same disclosure the original
`supporter-ticker.explain.md`/`paid-vote.explain.md` artifacts carry for their own small-table
sequential scans. Whether `interaction_definitions` needs a partial index on
`(channel_id, interaction_type, is_enabled)` for the `active_definition` resolution once a channel has
many closed/expired votes is a real open question for a later slice once a realistic row count is
measurable — not decided here, and not invented as a number with no authority behind it.

## Raw EXPLAIN output — literal function-call query

```
Function Scan on list_overlay_tug_of_war_vote  (cost=0.25..10.25 rows=1000 width=105) (actual time=5.137..5.138 rows=2 loops=1)
  Buffers: shared hit=1688 read=5
Planning Time: 0.027 ms
Execution Time: 5.201 ms
```

## Raw EXPLAIN output — supplementary: function body unwrapped, parameters substituted with the same seeded literal values

This is the real plan for the SQL text covered by `query_hash` above (the function body, not the wrapper call). Trimmed to the load-bearing nodes — the full 120-line capture additionally shows every `never executed` InitPlan short-circuit (the `winner`/`resolved_option_key` branches, correctly skipped because the seeded vote is not yet resolved).

```
Sort  (cost=3459.99..3460.00 rows=3 width=129) (actual time=0.163..0.166 rows=2 loops=1)
  Sort Key: t.amount_paise DESC, t.option_key
  Buffers: shared hit=36
  CTE scoped_channel
    ->  Index Scan using overlay_sessions_pkey on overlay_sessions session  (cost=0.15..8.18 rows=1 width=16) (actual time=0.006..0.007 rows=1 loops=1)
          Index Cond: (id = '00000000-0000-4000-8000-000000009999'::uuid)
          Filter: ((revoked_at IS NULL) AND (token_fingerprint = '...'::text) AND (expires_at > CURRENT_TIMESTAMP))
  CTE active_definition
    ->  Limit  (cost=3405.67..3405.67 rows=1 width=25) (actual time=0.059..0.059 rows=1 loops=1)
          ->  Sort  (cost=3405.67..3405.67 rows=1 width=25) (actual time=0.058..0.058 rows=1 loops=1)
                Sort Key: ((def.closed_at IS NULL)) DESC, (COALESCE(def.closed_at, def.created_at)) DESC
                ->  Nested Loop  (cost=0.00..3405.66 rows=1 width=25) (actual time=0.031..0.032 rows=1 loops=1)
                      Join Filter: (sc.channel_id = def.channel_id)
                      ->  Seq Scan on interaction_definitions def  (cost=0.00..3405.62 rows=1 width=48) (actual time=0.022..0.023 rows=1 loops=1)
                            Filter: (is_enabled AND (interaction_type = 'support_vote'::text) AND ((config ->> 'votingMode'::text) = 'paid'::text) AND ((SubPlan 2) = 2))
                            SubPlan 2
                              ->  Aggregate  (cost=11.29..11.30 rows=1 width=8) (actual time=0.011..0.011 rows=1 loops=1)
                                    ->  Bitmap Heap Scan on interaction_vote_options opt  (cost=4.17..11.28 rows=3 width=0) (actual time=0.007..0.008 rows=2 loops=1)
                                          Recheck Cond: (interaction_definition_id = def.id)
                                          ->  Bitmap Index Scan on interaction_vote_options_interaction_definition_id_option_k_key  (cost=0.00..4.17 rows=3 width=0) (actual time=0.004..0.004 rows=2 loops=1)
                                                Index Cond: (interaction_definition_id = def.id)
                      ->  CTE Scan on scoped_channel sc  (cost=0.00..0.02 rows=1 width=16) (actual time=0.007..0.007 rows=1 loops=1)
  CTE tallies
    ->  GroupAggregate  (cost=37.56..37.63 rows=3 width=96) (actual time=0.129..0.132 rows=2 loops=1)
          Group Key: opt_1.option_key, opt_1.label
          ->  Sort  (cost=37.56..37.57 rows=3 width=96) (actual time=0.122..0.124 rows=2 loops=1)
                ->  Nested Loop Left Join  (cost=21.51..37.54 rows=3 width=96) (actual time=0.112..0.116 rows=2 loops=1)
                      Join Filter: (tag.option_key = opt_1.option_key)
                      ->  Nested Loop  (cost=4.17..11.33 rows=3 width=64) (actual time=0.061..0.062 rows=2 loops=1)
                            ->  CTE Scan on active_definition ad  (cost=0.00..0.02 rows=1 width=16) (actual time=0.059..0.059 rows=1 loops=1)
                            ->  Bitmap Heap Scan on interaction_vote_options opt_1  (cost=4.17..11.28 rows=3 width=80) (actual time=0.001..0.001 rows=2 loops=1)
                                  Recheck Cond: (interaction_definition_id = ad.id)
                                  ->  Bitmap Index Scan on interaction_vote_options_interaction_definition_id_option_k_key  (cost=0.00..4.17 rows=3 width=0) (actual time=0.000..0.001 rows=2 loops=1)
                      ->  Materialize  (cost=17.34..26.16 rows=1 width=64) (actual time=0.022..0.026 rows=2 loops=2)
                            ->  Nested Loop Left Join  (cost=17.34..26.16 rows=1 width=64) (actual time=0.041..0.049 rows=2 loops=1)
                                  Join Filter: (refund.payment_id = payment.id)
                                  ->  Nested Loop  (cost=0.44..9.16 rows=1 width=56) (actual time=0.021..0.027 rows=2 loops=1)
                                        ->  Nested Loop  (cost=0.29..8.69 rows=1 width=192) (actual time=0.014..0.018 rows=2 loops=1)
                                              Join Filter: (tag.interaction_definition_id = ad_1.id)
                                              ->  Nested Loop  (cost=0.29..8.66 rows=1 width=208) (actual time=0.013..0.016 rows=2 loops=1)
                                                    Join Filter: (tag.channel_id = sc_1.channel_id)
                                                    ->  Nested Loop  (cost=0.14..8.19 rows=1 width=192) (actual time=0.005..0.006 rows=2 loops=1)
                                                          ->  CTE Scan on scoped_channel sc_1  (cost=0.00..0.02 rows=1 width=16) (actual time=0.000..0.000 rows=1 loops=1)
                                                          ->  Index Scan using payment_order_intents_idempotency_unique on payment_order_intents intent  (cost=0.14..8.16 rows=1 width=176) (actual time=0.004..0.005 rows=2 loops=1)
                                                                Index Cond: (channel_id = sc_1.channel_id)
                                                    ->  Index Scan using vote_payment_tags_channel_id_environment_idempotency_key_key on vote_payment_tags tag  (cost=0.15..0.45 rows=1 width=128) (actual time=0.004..0.004 rows=1 loops=2)
                                                          Index Cond: ((channel_id = intent.channel_id) AND (environment = intent.environment) AND (idempotency_key = intent.idempotency_key))
                                              ->  CTE Scan on active_definition ad_1  (cost=0.00..0.02 rows=1 width=16) (actual time=0.000..0.000 rows=1 loops=2)
                                        ->  Index Scan using payments_order_account_idx on payments payment  (cost=0.14..0.46 rows=1 width=152) (actual time=0.004..0.004 rows=1 loops=2)
                                              Index Cond: ((provider = intent.provider) AND (environment = intent.environment) AND (connected_account_ref = intent.connected_account_ref) AND (provider_order_id = intent.provider_order_id))
                                              Filter: (status = ANY ('{captured,refunded,partially_refunded}'::text[]))
                                  ->  GroupAggregate  (cost=16.90..16.96 rows=3 width=48) (actual time=0.009..0.009 rows=0 loops=2)
                                        Group Key: refund.payment_id
                                        ->  Sort  (cost=16.90..16.91 rows=3 width=24) (actual time=0.009..0.009 rows=0 loops=2)
                                              ->  Seq Scan on refunds refund  (cost=0.00..16.88 rows=3 width=24) (actual time=0.001..0.001 rows=0 loops=1)
                                                    Filter: (status = 'processed'::text)
  CTE is_closed
    ->  Nested Loop  (cost=0.15..8.24 rows=1 width=1) (actual time=0.006..0.006 rows=1 loops=1)
          ->  CTE Scan on active_definition ad_2  (cost=0.00..0.02 rows=1 width=16) (actual time=0.000..0.000 rows=1 loops=1)
          ->  Index Scan using interaction_definitions_pkey on interaction_definitions def_1  (cost=0.15..8.17 rows=1 width=24) (actual time=0.004..0.004 rows=1 loops=1)
                Index Cond: (id = ad_2.id)
  ->  CTE Scan on tallies t  (cost=0.00..0.06 rows=3 width=129) (actual time=0.139..0.140 rows=2 loops=1)
Planning:
  Buffers: shared hit=641
Planning Time: 3.465 ms
Execution Time: 0.376 ms
```
