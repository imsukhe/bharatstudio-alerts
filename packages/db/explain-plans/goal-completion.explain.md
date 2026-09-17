# goal-completion — EXPLAIN plan artifact (GOA-01/GOA-02/GOA-03)

Function: `app_private.get_channel_goal_completion(uuid, uuid)`
Defined at: `packages/db/migrations/0150_v1_goa_goal_completion_latch.sql:187` (block spans lines 172-226)

Not required by `scan-required-queries.mjs` (this read lives in `apps/api/src/db/goal-store.ts`,
which is neither an overlay-facing store file under rule 2 nor routed through the
`derivedReadSql` pool under rule 3, and the function is not named `list_overlay_*` under rule 1
— confirmed by running `node packages/db/explain-plans/scan-required-queries.mjs` before and
after adding this entry, both green). Captured anyway because it is this task's own explicit
minimum, and because it is a read that resolves against `public.payments`/`public.refunds`
indirectly (through `app_private.support_goal_progress_paise`) and deserves the same plan-shape
scrutiny as the manifest-required reads.

## Exact query run

Seeded channel id: `00000000-0000-4000-8000-000000000011` (base_world). Seeded goal id (from a
fresh `create_support_goal` call in this capture session): `3292ee80-1fcf-46ec-bae2-b2e157af7a50`.

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM app_private.get_channel_goal_completion('00000000-0000-4000-8000-000000000011'::uuid, '3292ee80-1fcf-46ec-bae2-b2e157af7a50'::uuid);
```

query_hash: `b10c131f797c3d783734b86a2b2e671b1f5369d4488feabbf7ab58c33dbbaf20`

Computed by extracting the exact text from the `create or replace function
app_private.get_channel_goal_completion(` line through the terminating `$$;` line (inclusive) out
of `packages/db/migrations/0150_v1_goa_goal_completion_latch.sql` as it exists at capture time,
then `sha256sum`-ing that extracted text verbatim (UTF-8, including original newlines/whitespace)
— the identical extraction `packages/db/explain-plans/check-plans.mjs` re-runs against the
migration file's CURRENT contents on every check.

captured_at: 2026-09-17T13:47:00Z
postgres_version: postgres:16-alpine (PostgreSQL 16.14 on aarch64-unknown-linux-musl, compiled by
gcc (Alpine 15.2.0) 15.2.0, 64-bit)

This EXPLAIN was captured against an unseeded/minimally-seeded local database (base_world plus
one goal and one payment), not FULL-PRODUCT-DEFINITION.md §37.4's production-scale dataset. It is
a plan-shape change detector only, not evidence any §19.4 performance budget is met at production
scale.

## Plan shape

Wrapper call: opaque `Function Scan on get_channel_goal_completion` — same reason as every other
artifact in this directory: the function is `security definer`, and PostgreSQL's planner never
inlines a SECURITY DEFINER function regardless of its volatility (`inline_function()` in
`src/backend/optimizer/util/clauses.c`: `if (funcform->prosecdef) goto fail;`). Unlike the other
ten RT-12 functions, this one is also `language plpgsql` (not `language sql`), so there is no
single SQL text to "unwrap" the way `goal.explain.md` does — the function body is procedural (a
role check, a call to `app_private.latch_support_goal_completion`, then a `return query`). The
supplementary capture below is therefore the EXPLAIN of that `return query` SELECT on its own,
literal values substituted for `goal.id`/`target_channel_id` — the actual join/scan shape the read
half of this function resolves to, exactly as it appears in the migration. The write half (the
latch's own idempotent `insert ... on conflict ... do nothing`) is a single-row point insert
against the `support_goal_completions_active_idx` unique index and is not separately profiled
here — nothing about it varies with data volume the way a join does.

## Raw EXPLAIN output — literal function-call query

```
Function Scan on get_channel_goal_completion  (cost=0.25..10.25 rows=1000 width=113) (actual time=4.036..4.036 rows=1 loops=1)
  Buffers: shared hit=820 read=15 dirtied=7 written=4
Planning Time: 0.019 ms
Execution Time: 4.046 ms
```

(`read`/`dirtied`/`written` buffers reflect the idempotent latch's own `insert ... on conflict`
touching the new unique index and the row itself on this first-ever call for this goal; a repeat
call on an already-completed goal is read-only against `support_goal_completions_active_idx` and
touches no dirtied/written buffers.)

## Raw EXPLAIN output — supplementary: the function's own `return query` SELECT, unwrapped

```
Nested Loop Left Join  (cost=9.81..26.12 rows=1 width=113) (actual time=3.319..3.321 rows=1 loops=1)
  Buffers: shared hit=663
  ->  Nested Loop Left Join  (cost=0.29..16.34 rows=1 width=64) (actual time=0.017..0.018 rows=1 loops=1)
        Buffers: shared hit=4
        ->  Index Scan using support_goals_pkey on support_goals goal  (cost=0.15..8.17 rows=1 width=24) (actual time=0.005..0.006 rows=1 loops=1)
              Index Cond: (id = '3292ee80-1fcf-46ec-bae2-b2e157af7a50'::uuid)
              Filter: (channel_id = '00000000-0000-4000-8000-000000000011'::uuid)
              Buffers: shared hit=2
        ->  Index Scan using support_goal_completions_active_idx on support_goal_completions completion  (cost=0.14..8.16 rows=1 width=56) (actual time=0.010..0.010 rows=1 loops=1)
              Index Cond: (goal_id = '3292ee80-1fcf-46ec-bae2-b2e157af7a50'::uuid)
              Buffers: shared hit=2
  ->  Limit  (cost=9.52..9.52 rows=1 width=56) (actual time=0.021..0.022 rows=0 loops=1)
        Buffers: shared hit=5
        ->  Sort  (cost=9.52..9.52 rows=1 width=56) (actual time=0.021..0.021 rows=0 loops=1)
              Sort Key: r.reopened_at DESC
              Sort Method: quicksort  Memory: 25kB
              Buffers: shared hit=5
              ->  Bitmap Heap Scan on support_goal_completions r  (cost=4.16..9.51 rows=1 width=56) (actual time=0.004..0.004 rows=0 loops=1)
                    Recheck Cond: (goal_id = goal.id)
                    Filter: (status = 'reopened'::text)
                    Rows Removed by Filter: 1
                    Heap Blocks: exact=1
                    Buffers: shared hit=2
                    ->  Bitmap Index Scan on support_goal_completions_goal_history_idx  (cost=0.00..4.16 rows=2 width=0) (actual time=0.001..0.001 rows=1 loops=1)
                          Index Cond: (goal_id = goal.id)
                          Buffers: shared hit=1
Planning:
  Buffers: shared hit=182
Planning Time: 0.629 ms
Execution Time: 3.375 ms
```

Both index scans this query needs (`support_goals_pkey`, `support_goal_completions_active_idx`)
resolve by index, and the reopen-history lookup resolves through
`support_goal_completions_goal_history_idx` — no sequential scan anywhere in this plan.
