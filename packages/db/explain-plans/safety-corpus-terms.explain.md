# safety-corpus-terms — EXPLAIN plan artifact (RT-12; SAF phase 1, moderation pipeline spine)

Function: `app_private.get_safety_corpus_terms(uuid)`
Defined at: `packages/db/migrations/0151_v1_saf_moderation_pipeline_spine.sql:331` (block spans through its terminating `$$;`)

## Exact query run

Seeded owner id: `00000000-0000-4000-8000-000000009996`
Seeded channel id: `00000000-0000-4000-8000-000000009998`
Two seeded `safety_corpus_terms` rows: one global (`channel_id` null, `rt12_global_term`), one owned by the seeded channel (`rt12_channel_term`). `ANALYZE` was run before capture.

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM app_private.get_safety_corpus_terms('00000000-0000-4000-8000-000000009998'::uuid);
```

The call returns exactly two rows -- the global term and the channel's own term, the "global plus per-creator" union SAF-05 requires as one read. Eight columns per row: `id, channel_id, term, whole_word, display_decision, tts_decision, moderator_review_decision, created_at` -- asserted exactly by `packages/db/tests/saf_pipeline_spine.sql` against `information_schema.parameters`.

query_hash: `0463d6c7f354ed630f2018e971906952a3ab296145e89f9be47b7bad8b656600`

Computed by extracting the exact text from the `create or replace function app_private.get_safety_corpus_terms(` line through the terminating `$$;` line (inclusive) out of `packages/db/migrations/0151_v1_saf_moderation_pipeline_spine.sql` as it exists at capture time, then `sha256sum`-ing that extracted text verbatim (UTF-8, including original newlines/whitespace) -- the identical extraction `packages/db/explain-plans/check-plans.mjs` re-runs against the migration file's CURRENT contents on every check.

captured_at: 2026-09-17T00:00:00Z
postgres_version: postgres:16-alpine (PostgreSQL 16.14 on aarch64-unknown-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit)

This EXPLAIN was captured against a minimally-seeded local database (one channel, two `safety_corpus_terms` rows), **not** FULL-PRODUCT-DEFINITION.md §37.4's production-scale dataset (a corpus at production scale could hold hundreds of global terms plus many per-channel additions). It is a plan-shape change detector only -- proof the query still resolves to the same kind of plan as when it was last captured -- and it is **NOT** evidence that any §19.4 performance budget is met at production scale, nor any form of production, provider, device, network or release readiness. §19.0's RT-07 remains Blocked and is the only row that can supply that evidence.

Per the task's own instruction, this artifact exists even though `get_safety_corpus_terms` has no overlay session anywhere near it (it is a creator/dashboard corpus-management read, called from `apps/api/src/db/safety-corpus-store.ts`'s `list()` -- wired to `derivedReadSql` -- and again inside `create()` to re-read the row just inserted): "the task's own instructions require an explain-plans entry regardless", the identical posture `capability-resolution.explain.md` already recorded for `app_private.get_channel_capabilities`.

## Plan shape

Wrapper call: opaque `Function Scan on get_safety_corpus_terms` (security definer, never inlined by the planner -- the same correction every other artifact in this directory carries; see `capability-resolution.explain.md`'s own note for the general shape). Unwrapped body: after its `has_channel_role` gate, the function is a single `select ... from safety_corpus_terms where channel_id is null or channel_id = target_channel_id order by created_at asc, id asc` -- one sequential scan at this seed size (two rows total), no join.

**First call**: `Buffers: shared hit=194`, 0.694 ms. This is the more expensive of the two captures -- the majority of the buffer traffic is PL/pgSQL's own security-definer call/catalog/role-check overhead (`has_channel_role`, `channel_memberships` lookup), consistent with every other opaque-Function-Scan wrapper artifact in this directory, plus the one `Seq Scan on safety_corpus_terms` (`Filter: ((channel_id IS NULL) OR (channel_id = $1))`, 2 rows returned out of 2 rows in the table -- no rows filtered out at this seed size).

**Second call (nothing changed)**: `Buffers: shared hit=2`, 0.109 ms -- roughly two orders of magnitude fewer buffer hits, entirely attributable to catalogue/plan caching across the two calls in the same session (there is no `safety_corpus_terms`-specific cache table in this migration the way CTL-03's `capability_resolutions` provides one; `get_safety_corpus_terms` always re-scans the table on every call, by design -- an empty-by-default corpus with, at launch, a small number of rows does not need a resolved-blob cache the way a per-capability resolution across many capabilities does).

`safety_corpus_terms_channel_idx` (on `channel_id`) exists (confirmed in the capture run's own index listing, reproduced below) and is declined by the planner at this seed size (two rows total) for the same reason every other near-empty-table lookup in this directory is: an index lookup buys nothing over a sequential scan of a two-row table. At production scale (many global terms, many per-channel additions), this is exactly where `safety_corpus_terms_channel_idx` would be expected to engage -- this artifact is not that evidence (see the production-scale caveat above).

## Raw EXPLAIN output — literal function-call query, first call

```
Function Scan on get_safety_corpus_terms  (cost=0.25..10.25 rows=1000 width=169) (actual time=0.688..0.689 rows=2 loops=1)
  Buffers: shared hit=194
Planning Time: 0.014 ms
Execution Time: 0.694 ms
```

## Raw EXPLAIN output — literal function-call query, second call (nothing changed)

```
Function Scan on get_safety_corpus_terms  (cost=0.25..10.25 rows=1000 width=169) (actual time=0.106..0.107 rows=2 loops=1)
  Buffers: shared hit=2
Planning Time: 0.005 ms
Execution Time: 0.109 ms
```

## Index listing at capture time (`pg_indexes`, `tablename = 'safety_corpus_terms'`)

```
safety_corpus_terms_pkey             | CREATE UNIQUE INDEX safety_corpus_terms_pkey ON public.safety_corpus_terms USING btree (id)
safety_corpus_terms_global_term_idx  | CREATE UNIQUE INDEX safety_corpus_terms_global_term_idx ON public.safety_corpus_terms USING btree (lower(btrim(term))) WHERE (channel_id IS NULL)
safety_corpus_terms_channel_term_idx | CREATE UNIQUE INDEX safety_corpus_terms_channel_term_idx ON public.safety_corpus_terms USING btree (channel_id, lower(btrim(term))) WHERE (channel_id IS NOT NULL)
safety_corpus_terms_channel_idx      | CREATE INDEX safety_corpus_terms_channel_idx ON public.safety_corpus_terms USING btree (channel_id)
```

## Returned columns (`information_schema.parameters`, `specific_name LIKE 'get_safety_corpus_terms%'`)

```
target_channel_id         | uuid                      | 1  (IN)
id                        | uuid                      | 2  (OUT)
channel_id                | uuid                      | 3  (OUT)
term                       | text                      | 4  (OUT)
whole_word                 | boolean                   | 5  (OUT)
display_decision           | text                      | 6  (OUT)
tts_decision                | text                      | 7  (OUT)
moderator_review_decision   | text                      | 8  (OUT)
created_at                  | timestamp with time zone  | 9  (OUT)
```

Eight OUT columns, exactly matching `safety_corpus_terms`'s own creator-relevant fields -- no `created_by` (who added the term is not part of this read), matching the same minimal-projection discipline every other creator-facing read in this schema follows.
