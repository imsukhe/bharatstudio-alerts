# safety-domain-rules — EXPLAIN plan artifact (RT-12; SAF-10, extending the moderation pipeline spine, migration 0151)

Function: `app_private.get_url_domain_rules(uuid)`
Defined at: `packages/db/migrations/0154_v1_saf_url_ssml_pii_guards.sql:113` (block spans through its terminating `$$;`)

## Exact query run

Seeded owner id: `00000000-0000-4000-8000-000000009996`
Seeded channel id: `00000000-0000-4000-8000-000000009998`
Two seeded `safety_domain_rules` rows for that one channel: `rt12deny.example` (`deny`) and `rt12allow.example` (`allow`) -- there is no "global" scope for SAF-10 (unlike the SAF-05 corpus), so both seeded rows belong to the one channel. `ANALYZE` was run before capture.

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM app_private.get_url_domain_rules('00000000-0000-4000-8000-000000009998'::uuid);
```

The call returns exactly two rows -- this channel's own two domain rules, the entire set SAF-10 defines for it (no global rows exist to union in). Four columns per row: `id, domain, rule, created_at` -- asserted exactly by `packages/db/tests/saf_url_ssml_pii.sql` against `information_schema.parameters`.

query_hash: `4f8518fc50963195696a57c0bffd70f74a0eaead96402f3e2acf746e86cbbd4a`

Computed by extracting the exact text from the `create or replace function app_private.get_url_domain_rules(` line through the terminating `$$;` line (inclusive) out of `packages/db/migrations/0154_v1_saf_url_ssml_pii_guards.sql` as it exists at capture time, then `sha256sum`-ing that extracted text verbatim (UTF-8, including original newlines/whitespace) -- the identical extraction `packages/db/explain-plans/check-plans.mjs` re-runs against the migration file's CURRENT contents on every check.

captured_at: 2026-09-17T00:00:00Z
postgres_version: postgres:16-alpine (PostgreSQL 16.14 on aarch64-unknown-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit)

This EXPLAIN was captured against a minimally-seeded local database (one channel, two `safety_domain_rules` rows), **not** FULL-PRODUCT-DEFINITION.md §37.4's production-scale dataset (a channel at production scale could hold many domain rules). It is a plan-shape change detector only -- proof the query still resolves to the same kind of plan as when it was last captured -- and it is **NOT** evidence that any §19.4 performance budget is met at production scale, nor any form of production, provider, device, network or release readiness. §19.0's RT-07 remains Blocked and is the only row that can supply that evidence.

Per the task's own instruction, this artifact exists even though `get_url_domain_rules` has no overlay session anywhere near it (it is a creator/dashboard domain-rule-management read, called from `apps/api/src/db/url-domain-rule-store.ts`'s `list()` -- wired to `derivedReadSql` -- and again inside `create()` to re-read the row just inserted): the identical posture `safety-corpus-terms.explain.md` already recorded for `app_private.get_safety_corpus_terms`.

## Plan shape

Wrapper call: opaque `Function Scan on get_url_domain_rules` (security definer, never inlined by the planner -- the same correction every other artifact in this directory carries; see `capability-resolution.explain.md`'s own note for the general shape). Unwrapped body: after its `has_channel_role` gate, the function is a single `select id, domain, rule, created_at from safety_domain_rules where channel_id = target_channel_id order by created_at asc, id asc` -- one sequential scan at this seed size (two rows total), no join.

**First call**: `Buffers: shared hit=143`, 0.502 ms. This is the more expensive of the two captures -- the majority of the buffer traffic is PL/pgSQL's own security-definer call/catalog/role-check overhead (`has_channel_role`, `channel_memberships` lookup), consistent with every other opaque-Function-Scan wrapper artifact in this directory, plus the one `Seq Scan on safety_domain_rules` (`Filter: (channel_id = $1)`, 2 rows returned out of 2 rows in the table -- no rows filtered out at this seed size).

**Second call (nothing changed)**: `Buffers: shared hit=3`, 0.138 ms -- roughly two orders of magnitude fewer buffer hits, entirely attributable to catalogue/plan caching across the two calls in the same session (there is no `safety_domain_rules`-specific cache table this migration provides one; `get_url_domain_rules` always re-scans the table on every call, by design -- an empty-by-default rule list with, at launch, a small number of rows per channel does not need a resolved-blob cache the way a per-capability resolution across many capabilities does).

`safety_domain_rules_channel_idx` (on `channel_id`) exists (confirmed in the capture run's own index listing, reproduced below) and is declined by the planner at this seed size (two rows total, one channel) for the same reason every other near-empty-table lookup in this directory is: an index lookup buys nothing over a sequential scan of a two-row table. At production scale (many channels, many domain rules each), this is exactly where `safety_domain_rules_channel_idx` would be expected to engage -- this artifact is not that evidence (see the production-scale caveat above). `safety_domain_rules_channel_domain_idx` (the unique index proving SAF-10's structural allow/deny precedence guarantee -- packages/db/migrations/0154's own header) is a write-side constraint, not consulted by this read at all.

## Raw EXPLAIN output — literal function-call query, first call

```
Function Scan on get_url_domain_rules  (cost=0.25..10.25 rows=1000 width=88) (actual time=0.496..0.496 rows=2 loops=1)
  Buffers: shared hit=143
Planning Time: 0.013 ms
Execution Time: 0.502 ms
```

## Raw EXPLAIN output — literal function-call query, second call (nothing changed)

```
Function Scan on get_url_domain_rules  (cost=0.25..10.25 rows=1000 width=88) (actual time=0.134..0.134 rows=2 loops=1)
  Buffers: shared hit=3
Planning Time: 0.016 ms
Execution Time: 0.138 ms
```

## Index listing at capture time (`pg_indexes`, `tablename = 'safety_domain_rules'`)

```
safety_domain_rules_channel_domain_idx  | CREATE UNIQUE INDEX safety_domain_rules_channel_domain_idx ON public.safety_domain_rules USING btree (channel_id, domain)
safety_domain_rules_channel_idx         | CREATE INDEX safety_domain_rules_channel_idx ON public.safety_domain_rules USING btree (channel_id)
safety_domain_rules_pkey                | CREATE UNIQUE INDEX safety_domain_rules_pkey ON public.safety_domain_rules USING btree (id)
```

## Returned columns (`information_schema.parameters`, `specific_name LIKE 'get_url_domain_rules%'`)

```
target_channel_id  | uuid                      | 1  (IN)
id                 | uuid                      | 2  (OUT)
domain              | text                      | 3  (OUT)
rule                 | text                      | 4  (OUT)
created_at            | timestamp with time zone  | 5  (OUT)
```

Four OUT columns, exactly matching `safety_domain_rules`'s own creator-relevant fields -- no `created_by` (who added the rule is not part of this read) and no `channel_id` (the caller already supplied it as the filter, and a per-channel list has no reason to echo it back on every row) -- the same minimal-projection discipline every other creator-facing read in this schema follows.
