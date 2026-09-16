# challenge — EXPLAIN plan artifact (RT-12)

Function: `app_private.list_overlay_challenge(uuid, text)`
Defined at: `packages/db/migrations/0109_v1_l17_paid_challenges.sql:344` (block spans lines 344-369)

## Exact query run

Seeded overlay session id: `00000000-0000-0000-0000-000000000003`
Seeded token fingerprint (sha256 hex of the fixed string `rt12-explain-capture-token`): `aca8464c4445892c4627b19f1335ae66b84c87976e994d973b1c15769cf3f56d`

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM app_private.list_overlay_challenge('00000000-0000-0000-0000-000000000003'::uuid, 'aca8464c4445892c4627b19f1335ae66b84c87976e994d973b1c15769cf3f56d');
```

query_hash: `a2eb5037a55626d21af578b043877bb551c6133d82b19779615333ee3d58d453`

Computed by extracting the exact text from the `create or replace function app_private.list_overlay_challenge(` line through the terminating `$$;` line (inclusive) out of `packages/db/migrations/0109_v1_l17_paid_challenges.sql` as it exists at capture time, then `sha256sum`-ing that extracted text verbatim (UTF-8, including original newlines/whitespace). This is the identical extraction `packages/db/explain-plans/check-plans.mjs` re-runs against the migration file's CURRENT contents on every check; a hash mismatch means the function body changed since this artifact was captured and the plan needs re-verification.

captured_at: 2026-09-16T04:32:22Z
postgres_version: postgres:16-alpine (PostgreSQL 16.14 on aarch64-unknown-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit)

This EXPLAIN was captured against an unseeded/minimally-seeded local database (a handful of synthetic rows), not FULL-PRODUCT-DEFINITION.md §37.4's production-scale dataset (500 channels / 2,000,000 payments / 5,000,000 alert events / 200,000 supporter identities). It is a plan-shape change detector only — proof that the query still resolves to the same kind of plan (index scan vs. sequential scan) as when it was last captured — and it is NOT evidence that any §19.4 performance budget is met at production scale.

## Plan shape

Wrapper call: opaque `Function Scan on list_overlay_challenge` (security definer, never inlined). Unwrapped body: `Limit -> Result -> Sort -> Hash Join(Index Scan using overlay_sessions_pkey on overlay_sessions, Seq Scan on challenges)`. The `Seq Scan on challenges` is honest at this seed size (2 synthetic rows, well below Postgres's cost-based threshold for preferring an index scan regardless of `challenges_channel_open_idx` existing) — not evidence of production-size behaviour.

**Correction to the RT-12 task brief's premise:** the brief assumed that because these ten functions are `language sql stable`, Postgres would inline them into the outer plan on `EXPLAIN SELECT * FROM app_private.<fn>(...)`, exposing the real join/scan plan directly. That assumption does not hold here: all ten functions (and the two `security definer` helpers `app_private.channel_leaderboard` and, transitively, `app_private.hype_mode_state`'s caller) are additionally declared `security definer`, and PostgreSQL's planner never inlines a SECURITY DEFINER SQL function regardless of STABLE/IMMUTABLE (see `inline_function()` in `src/backend/optimizer/util/clauses.c`: `if (funcform->prosecdef) goto fail;`) — inlining a security-definer function would let its body execute with the *caller's* privileges/search_path instead of the definer's, which Postgres refuses to risk. The literal command from the RT-12 task text therefore reliably produces an opaque `Function Scan on <fn>` node with no visible join/scan detail, on every Postgres version, not just this capture. To still get the real join/scan plan-shape evidence RT-12 actually wants, this artifact captures **both**: (1) the literal function-call EXPLAIN exactly as the task specified (reproducible, verbatim), and (2) a supplementary "unwrapped" EXPLAIN of the function's own body with its parameters substituted by literal values — the same SQL text this function's `query_hash` covers — which Postgres plans and executes as an ordinary query and which therefore surfaces the real index/seq scan nodes. Where the unwrapped body itself calls another `security definer` function (`channel_leaderboard`, `hype_mode_state`), that inner call remains its own opaque `Function Scan` node for the same reason — noted per widget below.

## Raw EXPLAIN output — literal function-call query (as specified by the RT-12 task text)

```
Function Scan on list_overlay_challenge  (cost=0.25..10.25 rows=1000 width=129) (actual time=4.256..4.256 rows=1 loops=1)
  Buffers: shared hit=1209
Planning Time: 0.032 ms
Execution Time: 4.288 ms
```

## Raw EXPLAIN output — supplementary: function body unwrapped, parameters substituted with the same seeded literal values

This is the real join/scan plan for the SQL text covered by `query_hash` above (the function body, not the wrapper call).

```
Limit  (cost=21.94..22.46 rows=1 width=137) (actual time=2.666..2.667 rows=1 loops=1)
  Buffers: shared hit=682
  ->  Result  (cost=21.94..22.46 rows=1 width=137) (actual time=2.665..2.666 rows=1 loops=1)
        Buffers: shared hit=682
        ->  Sort  (cost=21.94..21.95 rows=1 width=128) (actual time=0.045..0.045 rows=1 loops=1)
              Sort Key: c.updated_at DESC
              Sort Method: quicksort  Memory: 25kB
              Buffers: shared hit=6
              ->  Hash Join  (cost=8.19..21.93 rows=1 width=128) (actual time=0.026..0.028 rows=2 loops=1)
                    Hash Cond: (c.channel_id = session.channel_id)
                    Buffers: shared hit=3
                    ->  Seq Scan on challenges c  (cost=0.00..13.30 rows=165 width=144) (actual time=0.006..0.007 rows=2 loops=1)
                          Filter: is_public
                          Buffers: shared hit=1
                    ->  Hash  (cost=8.18..8.18 rows=1 width=16) (actual time=0.012..0.012 rows=1 loops=1)
                          Buckets: 1024  Batches: 1  Memory Usage: 9kB
                          Buffers: shared hit=2
                          ->  Index Scan using overlay_sessions_pkey on overlay_sessions session  (cost=0.15..8.18 rows=1 width=16) (actual time=0.009..0.009 rows=1 loops=1)
                                Index Cond: (id = '00000000-0000-0000-0000-000000000003'::uuid)
                                Filter: ((revoked_at IS NULL) AND (token_fingerprint = 'aca8464c4445892c4627b19f1335ae66b84c87976e994d973b1c15769cf3f56d'::text) AND (expires_at > CURRENT_TIMESTAMP))
                                Buffers: shared hit=2
Planning:
  Buffers: shared hit=251
Planning Time: 0.675 ms
Execution Time: 2.710 ms
```
