# safe-soundboard — EXPLAIN plan artifact (RT-12; §6 module #6, new in PRF-02 slice 7)

Function: `app_private.list_overlay_soundboard_play(uuid, text)`
Defined at: `packages/db/migrations/0143_v1_prf02_safe_soundboard.sql:707` (block spans lines 707-738)

New function, new in this slice, and the whole server-side read cost of §6 module #6's overlay
card. Captured as part of this slice's own work, per the "capture the artefact when the query is
written" discipline RT-12's closure established.

**The creator-facing functions have no artefact here, deliberately.**
`app_private.import_soundboard_catalogue_entry`, `list_soundboard_catalogue_for_channel`,
`set_channel_soundboard_catalogue_enabled`, `list_channel_soundboard_uploads`,
`upload_channel_soundboard_clip` and `trigger_soundboard_play` run on the MAIN pool through
`apps/api/src/db/safe-soundboard-store.ts`, not on RT-10/RT-11's `derivedReadSql`, and none of
them is a widget-backing derived read — so none of `scan-required-queries.mjs`'s three rules
requires one. They are asserted behaviourally instead, in
`packages/db/tests/prf02_slice7_safe_soundboard.sql`. This is the identical structural position
`db/lobby-status-store.ts` and `db/giveaway-tournament-store.ts` already occupy.

## Exact query run

Seeded overlay session id: `00000000-0000-4000-9100-000000000001`
Seeded token fingerprint: `explain-fingerprint-1`
Seeded data: **101 channels** (100 PRO/entitled, 1 FREE/unentitled probe), **101 overlay
sessions**, **1 first-party catalogue entry**, and **500 plays** — 5 per entitled channel, none
for the unentitled probe — so the channel/session predicate is captured filtering a real table
rather than matching everything. `ANALYZE` was run before capture.

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM app_private.list_overlay_soundboard_play('00000000-0000-4000-9100-000000000001'::uuid, 'explain-fingerprint-1');
```

```
 Function Scan on list_overlay_soundboard_play  (cost=0.25..10.25 rows=1000 width=156) (actual time=3.205..3.205 rows=1 loops=1)
   Buffers: shared hit=886
 Planning Time: 0.037 ms
 Execution Time: 3.238 ms
```

`language sql` functions are planned opaquely as a `Function Scan` from the calling side — this is
the same shape `giveaway-tournament.explain.md` and `lobby-status.explain.md` document for their
own `language sql` overlay reads, not a peculiarity of this one. The 886-buffer cost is dominated
by the entitlement check (`app_private.soundboard_module_entitled` reads
`channel_entitlement_versions`) and the `channel_soundboard_plays` scan against 500 seeded rows;
neither is large enough at today's scale to need a dedicated index beyond
`channel_soundboard_plays_channel_created_idx` (migration 0143), which the planner uses to satisfy
the `channel_id` filter and `created_at desc` ordering together.

The call returns **one row of the seven declared columns**, out of 500 plays across 100 entitled
channels:

```
               play_id                | clip_kind | display_name |            gcs_object_key            | mime_type  | duration_seconds |         triggered_at
--------------------------------------+-----------+--------------+---------------------------------------+------------+-------------------+-------------------------------
 ad8f98a0-6899-4406-850c-e8b9a9af1d13 | catalogue | Explain Horn | soundboard/catalogue/sb-explain-horn | audio/mpeg |                3 | 2026-09-17 04:58:52.836209+00
```

**Seven columns. That is the whole projection.** No viewer, supporter, session or participant
identifier exists anywhere in this schema for an eighth column to leak — `play_id` is an opaque
event id used only so the overlay client can de-duplicate a repeat poll of the same trigger, never
an identity. `gcs_object_key` is a content-addressed key fragment (migration 0143's check
constraints forbid a scheme, host or `..` segment in it); the API layer
(`apps/api/src/db/safe-soundboard-overlay-store.ts`) resolves it against the server's OWN
configured CDN base, never a caller-supplied URL — that base is itself CONFIGURED BUT UNSET in
every environment today, so `playbackUrl` is `null` on the live API until it is provisioned; this
artefact's raw SQL result correctly shows the object key, not a resolved URL, because URL
resolution happens outside this function.

### The entitlement gate is in the query, and this is the evidence

The same call, against the ONE Free-tier (unentitled) channel seeded — same valid, unexpired,
unrevoked token, same catalogue entry available, but zero plays triggered and, more importantly,
the module gate itself:

```
 rows_for_a_free_channel
-------------------------
                       0
```

§30.3 lists "Sound Moments (catalogue)" as Pro+ (Free: none). That check is
`app_private.soundboard_module_entitled` (migration 0143), **called from inside this function**
rather than reimplemented, and it is the same reason the row count above is zero even where a
plays row existed for other channels: an unentitled channel's perfectly valid overlay token
matches no row. The creator's own catalogue/upload/trigger routes are never gated this way (§12.6)
— only this one overlay read is.

query_hash: `2b454c061d0597dd2745583cb66321f31d1c85a232d7a67da89224d4fd62231d`

Computed by extracting the exact text from the `create or replace function app_private.list_overlay_soundboard_play(` line through the terminating `$$;` line (inclusive) out of `packages/db/migrations/0143_v1_prf02_safe_soundboard.sql` as it exists at capture time, then `sha256sum`-ing that extracted text verbatim (UTF-8, including original newlines/whitespace). This is the identical extraction `packages/db/explain-plans/check-plans.mjs` re-runs against the migration file's CURRENT contents on every check; a hash mismatch means the function body changed since this artifact was captured and the plan needs re-verification.

captured_at: 2026-09-17T00:00:00Z
postgres_version: postgres:16-alpine (PostgreSQL 16.14 on aarch64-unknown-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit)

This EXPLAIN was captured against a minimally-seeded local database (101 channels, 500 plays), not
a production dataset. It documents the query's structural cost and the entitlement gate's live
behaviour, not a production-scale benchmark.
