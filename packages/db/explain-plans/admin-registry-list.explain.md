# admin-registry-list — EXPLAIN plan artifact (ADM-07, migration 0156)

Function: `app_private.staff_list_platform_admins()`
Defined at: `packages/db/migrations/0156_v1_adm_durable_admin_registry.sql:215` (block spans through its terminating `$$;`)

## Why this artifact exists even though it is not overlay-facing

This function is not caught by `scan-required-queries.mjs`'s three rules: it is not `list_overlay_*`
(rule 1), it does not live in a file whose name contains `overlay`/`master-canvas` (rule 2), and
`apps/api/src/db/platform-admin-store.ts` is wired in `apps/api/src/index.ts` with the MAIN pool
`sql`, never `derivedReadSql` (rule 3 only follows `derivedReadSql`-tagged calls) — this is a
platform-staff governance surface, not a widget/dashboard read. It is captured anyway, for the
identical reason `emergency-kill-list.explain.md` (migration 0155) and
`capability-change-management-list.explain.md` (migration 0152) were: this vertical slice's own
instructions require an explain-plan entry regardless of overlay-facing status, and
`staff_list_platform_admins` is the representative capture for this migration's whole function set —
it is the one read function this migration adds; `staff_set_platform_admin` (the one write) shares no
separate row-shaping helper to capture in its place, the same posture `staff_set_platform_owner`
(migration 0155, Job 1) already took by having no required-queries.json entry of its own.

## Exact query run

Seeded ids: `00000000-0000-4000-8000-0000000ea001`, `...ea002`, `...ea003` (platform admins after
setup), `...ea004` (never granted). `...ea001` performed three `app_private.staff_set_platform_admin`
calls: a no-op demotion of `...ea002` (creates one audit row with `new_value = false`, exercising the
`left join lateral` against a target with more than one audit row so the `order by changed_at desc,
id desc limit 1` is actually exercised, not vacuously satisfied by a single row), then a real
promotion of `...ea002`, then a real promotion of `...ea003`. `VACUUM ANALYZE` was run on
`app_users` and `platform_admin_audit` before capture.

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM app_private.staff_list_platform_admins();
```

The call returns exactly the seven-column `PlatformAdminListEntry` projection asserted in
`packages/db/tests/adm_admin_registry.sql`: `user_id, display_name, is_platform_admin,
is_platform_owner, granted_by, granted_at, reason`.

```
Function Scan on staff_list_platform_admins  (cost=0.25..10.25 rows=1000 width=106) (actual time=0.614..0.614 rows=3 loops=1)
  Buffers: shared hit=171 read=1
Planning Time: 0.010 ms
Execution Time: 0.624 ms
```

## Raw EXPLAIN output — supplementary: the unwrapped listing query

A `plpgsql` function call is opaque to the planner (`Function Scan`, as above) — the query actually
run inside `staff_list_platform_admins`'s body is captured unwrapped here for a real look at its plan
shape, the same supplementary capture `emergency-kill-list.explain.md` took.

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
select au.id, au.display_name, au.is_platform_admin, au.is_platform_owner,
       latest.changed_by, latest.changed_at, latest.reason
  from public.app_users au
  left join lateral (
    select paa.changed_by, paa.changed_at, paa.reason
      from public.platform_admin_audit paa
     where paa.target_user_id = au.id
     order by paa.changed_at desc, paa.id desc
     limit 1
  ) latest on true
 where au.is_platform_admin and au.closed_at is null
 order by au.id;
```

```
Sort  (cost=4.27..4.28 rows=3 width=102) (actual time=0.055..0.055 rows=3 loops=1)
  Sort Key: au.id
  Sort Method: quicksort  Memory: 25kB
  Buffers: shared hit=10
  ->  Nested Loop Left Join  (cost=1.05..4.25 rows=3 width=102) (actual time=0.019..0.035 rows=3 loops=1)
        Buffers: shared hit=7
        ->  Seq Scan on app_users au  (cost=0.00..1.04 rows=3 width=42) (actual time=0.003..0.004 rows=3 loops=1)
              Filter: (is_platform_admin AND (closed_at IS NULL))
              Rows Removed by Filter: 1
              Buffers: shared hit=1
        ->  Limit  (cost=1.05..1.05 rows=1 width=76) (actual time=0.009..0.010 rows=1 loops=3)
              Buffers: shared hit=6
              ->  Sort  (cost=1.05..1.05 rows=2 width=76) (actual time=0.008..0.008 rows=1 loops=3)
                    Sort Key: paa.changed_at DESC, paa.id DESC
                    Sort Method: quicksort  Memory: 25kB
                    Buffers: shared hit=6
                    ->  Seq Scan on platform_admin_audit paa  (cost=0.00..1.04 rows=2 width=76) (actual time=0.001..0.001 rows=1 loops=3)
                          Filter: (target_user_id = au.id)
                          Rows Removed by Filter: 2
                          Buffers: shared hit=3
Planning:
  Buffers: shared hit=204
Planning Time: 0.534 ms
Execution Time: 0.080 ms
```

Honestly noted, not glossed over: at this seed size (3 admin rows, up to 2 audit rows per target),
the planner chooses a `Seq Scan` on `platform_admin_audit` inside the `LATERAL` rather than
`platform_admin_audit_target_idx (target_user_id, changed_at)` — a correct planner choice at this
row count, and unverified at production scale (this artifact does not claim the index is exercised
here; it exists for the per-target lookup to scale once the table has enough rows per admin for a seq
scan to stop being cheaper).

## Indexes confirmed present at capture time

```
 app_users            | app_users_external_subject_key         | CREATE UNIQUE INDEX ... USING btree (external_subject)
 app_users            | app_users_pkey                         | CREATE UNIQUE INDEX ... USING btree (id)
 app_users            | app_users_platform_owner_singleton_idx | CREATE UNIQUE INDEX ... USING btree (is_platform_owner) WHERE is_platform_owner
 platform_admin_audit | platform_admin_audit_pkey              | CREATE UNIQUE INDEX ... USING btree (id)
 platform_admin_audit | platform_admin_audit_target_idx        | CREATE INDEX ... USING btree (target_user_id, changed_at)
```

query_hash: `30900df3a647873ba55eee7d46074127d0bfe55ab89c2b74ff56df799450a1b0`

Computed by extracting the exact text from the `create or replace function
app_private.staff_list_platform_admins(` line through the terminating `$$;` line (inclusive) out of
`packages/db/migrations/0156_v1_adm_durable_admin_registry.sql` as it exists at capture time, then
`sha256sum`-ing that extracted text verbatim (UTF-8, including original newlines/whitespace) — the
identical extraction `packages/db/explain-plans/check-plans.mjs` re-runs against the migration file's
CURRENT contents on every check.

captured_at: 2026-09-17T17:33:00Z
