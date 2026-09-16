# leaderboard — EXPLAIN plan artifact (RT-12)

Function: `app_private.list_overlay_leaderboard(uuid, text, text)`
Defined at: `packages/db/migrations/0105_v1_l16_interaction_definitions_and_widgets.sql:1021` (block spans lines 1021-1035)

## Exact query run

Seeded overlay session id: `00000000-0000-0000-0000-000000000003`
Seeded token fingerprint (sha256 hex of the fixed string `rt12-explain-capture-token`): `aca8464c4445892c4627b19f1335ae66b84c87976e994d973b1c15769cf3f56d`

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM app_private.list_overlay_leaderboard('00000000-0000-0000-0000-000000000003'::uuid, 'aca8464c4445892c4627b19f1335ae66b84c87976e994d973b1c15769cf3f56d', 'monthly');
```

query_hash: `73a379cb09ca6b955c94c0f471822e9970e00386839d4144ac515525f3dfe0b2`

Computed by extracting the exact text from the `create or replace function app_private.list_overlay_leaderboard(` line through the terminating `$$;` line (inclusive) out of `packages/db/migrations/0105_v1_l16_interaction_definitions_and_widgets.sql` as it exists at capture time, then `sha256sum`-ing that extracted text verbatim (UTF-8, including original newlines/whitespace). This is the identical extraction `packages/db/explain-plans/check-plans.mjs` re-runs against the migration file's CURRENT contents on every check; a hash mismatch means the function body changed since this artifact was captured and the plan needs re-verification.

captured_at: 2026-09-16T04:32:22Z
postgres_version: postgres:16-alpine (PostgreSQL 16.14 on aarch64-unknown-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit)

This EXPLAIN was captured against an unseeded/minimally-seeded local database (a handful of synthetic rows), not FULL-PRODUCT-DEFINITION.md §37.4's production-scale dataset (500 channels / 2,000,000 payments / 5,000,000 alert events / 200,000 supporter identities). It is a plan-shape change detector only — proof that the query still resolves to the same kind of plan (index scan vs. sequential scan) as when it was last captured — and it is NOT evidence that any §19.4 performance budget is met at production scale.

## Plan shape

Wrapper call: opaque `Function Scan on list_overlay_leaderboard` (security definer, never inlined). Unwrapped body: `Nested Loop(Index Scan using overlay_sessions_pkey on overlay_sessions) -> Function Scan on channel_leaderboard`. The inner `channel_leaderboard` call stays an opaque Function Scan even in the unwrapped body — it is itself `language sql stable security definer`, so the same never-inlined rule applies to it too.

**Correction to the RT-12 task brief's premise:** the brief assumed that because these ten functions are `language sql stable`, Postgres would inline them into the outer plan on `EXPLAIN SELECT * FROM app_private.<fn>(...)`, exposing the real join/scan plan directly. That assumption does not hold here: all ten functions (and the two `security definer` helpers `app_private.channel_leaderboard` and, transitively, `app_private.hype_mode_state`'s caller) are additionally declared `security definer`, and PostgreSQL's planner never inlines a SECURITY DEFINER SQL function regardless of STABLE/IMMUTABLE (see `inline_function()` in `src/backend/optimizer/util/clauses.c`: `if (funcform->prosecdef) goto fail;`) — inlining a security-definer function would let its body execute with the *caller's* privileges/search_path instead of the definer's, which Postgres refuses to risk. The literal command from the RT-12 task text therefore reliably produces an opaque `Function Scan on <fn>` node with no visible join/scan detail, on every Postgres version, not just this capture. To still get the real join/scan plan-shape evidence RT-12 actually wants, this artifact captures **both**: (1) the literal function-call EXPLAIN exactly as the task specified (reproducible, verbatim), and (2) a supplementary "unwrapped" EXPLAIN of the function's own body with its parameters substituted by literal values — the same SQL text this function's `query_hash` covers — which Postgres plans and executes as an ordinary query and which therefore surfaces the real index/seq scan nodes. Where the unwrapped body itself calls another `security definer` function (`channel_leaderboard`, `hype_mode_state`), that inner call remains its own opaque `Function Scan` node for the same reason — noted per widget below.

## Raw EXPLAIN output — literal function-call query (as specified by the RT-12 task text)

```
Function Scan on list_overlay_leaderboard  (cost=0.25..10.25 rows=1000 width=68) (actual time=2.564..2.564 rows=2 loops=1)
  Buffers: shared hit=992
Planning Time: 0.036 ms
Execution Time: 2.587 ms
```

## Raw EXPLAIN output — supplementary: function body unwrapped, parameters substituted with the same seeded literal values

This is the real join/scan plan for the SQL text covered by `query_hash` above (the function body, not the wrapper call).

```
Nested Loop  (cost=0.40..28.42 rows=1000 width=68) (actual time=1.748..1.749 rows=2 loops=1)
  Buffers: shared hit=795
  ->  Index Scan using overlay_sessions_pkey on overlay_sessions session  (cost=0.15..8.18 rows=1 width=16) (actual time=0.010..0.011 rows=1 loops=1)
        Index Cond: (id = '00000000-0000-0000-0000-000000000003'::uuid)
        Filter: ((revoked_at IS NULL) AND (token_fingerprint = 'aca8464c4445892c4627b19f1335ae66b84c87976e994d973b1c15769cf3f56d'::text) AND (expires_at > CURRENT_TIMESTAMP))
        Buffers: shared hit=2
  ->  Function Scan on channel_leaderboard board  (cost=0.25..10.25 rows=1000 width=68) (actual time=1.736..1.736 rows=2 loops=1)
        Buffers: shared hit=793
Planning:
  Buffers: shared hit=101
Planning Time: 0.286 ms
Execution Time: 1.784 ms
```
