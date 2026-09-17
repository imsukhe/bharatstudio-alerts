# qr-smart-card — EXPLAIN plan artifact (RT-12; §6 module #10, QR Smart Card)

Function: `app_private.list_overlay_qr_smart_card(uuid, text)`
Defined at: `packages/db/migrations/0144_v1_prf02_slice7_qr_smart_card.sql:242` (block spans lines 242-260)

## Exact query run

Seeded overlay session id: `00000000-0000-4000-8000-000000009997`
Seeded token fingerprint (sha256 hex of the fixed string `rt12-explain-capture-token-s7`): `dfa3eabd969d400e4c16a504b0fb2cd645926191994016efb39ed0befe3a1fb3`
Seeded data: one channel with one enabled QR Smart Card (`destination = 'https://bharatstudio.in/creator/synthetic-a'`, `label = 'Follow on BharatStudio'`) and one valid overlay session. `ANALYZE` was run before capture.

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM app_private.list_overlay_qr_smart_card('00000000-0000-4000-8000-000000009997'::uuid, 'dfa3eabd969d400e4c16a504b0fb2cd645926191994016efb39ed0befe3a1fb3');
```

The call returns exactly one row: `destination = 'https://bharatstudio.in/creator/synthetic-a'`, `label = 'Follow on BharatStudio'`. **Two text columns. That is the whole projection** — the 2026-09-17 owner decision's "no scan counting, and no claim about how many people scanned anything" is enforced as a property of this query (there is no counter column to select in the first place), and
`packages/db/tests/prf02_slice7_qr_smart_card.sql` asserts the returned column set directly against `information_schema.parameters` (`destination,label`, nothing else).

query_hash: `c5d51393d9e80345e569eb4a15f2ed13c465c9a7d2e9dbfb102d1994713b2ef9`

Computed by extracting the exact text from the `create or replace function app_private.list_overlay_qr_smart_card(` line through the terminating `$$;` line (inclusive) out of `packages/db/migrations/0144_v1_prf02_slice7_qr_smart_card.sql` as it exists at capture time, then `sha256sum`-ing that extracted text verbatim (UTF-8, including original newlines/whitespace). This is the identical extraction `packages/db/explain-plans/check-plans.mjs` re-runs against the migration file's CURRENT contents on every check; a hash mismatch means the function body changed since this artifact was captured and the plan needs re-verification.

captured_at: 2026-09-17T00:00:00Z
postgres_version: postgres:16-alpine (PostgreSQL 16.14 on aarch64-unknown-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit)

This EXPLAIN was captured against a minimally-seeded local database (one channel, one card, one overlay session), **not** FULL-PRODUCT-DEFINITION.md §37.4's production-scale dataset (500 channels / 2,000,000 payments / 5,000,000 alert events / 200,000 supporter identities). It is a plan-shape change detector only — proof that the query still resolves to the same kind of plan as when it was last captured — and it is **NOT** evidence that any §19.4 performance budget is met at production scale, nor any form of production, provider, device, network or release readiness. §19.0's RT-07 remains Blocked and is the only row that can supply OBS/Chromium/device/soak evidence.

## Plan shape

Wrapper call: opaque `Function Scan on list_overlay_qr_smart_card` (security definer, never inlined — the same correction every other artifact in this directory carries; see `moderator-status.explain.md`'s own note for the general shape). Unwrapped body: a `Nested Loop` joining `overlay_sessions` (the session/token-fingerprint/revocation/expiry gate) to `qr_smart_cards` (the `is_enabled` predicate) on `channel_id`.

**Both leaf scans are sequential at this seed size, and both are honest rather than surprising:**

- **`Seq Scan on overlay_sessions`**, `Filter: ((revoked_at IS NULL) AND (id = ...) AND (token_fingerprint = ...) AND (expires_at > CURRENT_TIMESTAMP))`. `overlay_sessions_pkey` exists (confirmed in the capture run's own `pg_indexes` listing, reproduced below) and the planner declines it on a one-row table, exactly as every other overlay-read artifact in this directory records at this seed size (see `stream-mission.explain.md`, `moderator-status.explain.md`).
- **`Seq Scan on qr_smart_cards`**, `Filter: is_enabled`. `qr_smart_cards_pkey` is a primary key on `channel_id` (this migration's whole design: at most one card per channel, enforced by the database — see the migration's own header) and is declined by the planner at this seed size for the same reason. There is no separate index on `is_enabled`, and none is warranted: the join already narrows to at most one row via `channel_id`, so a predicate index on a boolean the join itself already pins to one row would add write cost without a compensating read benefit at any realistic per-channel cardinality (a channel has zero or one card, never many).

The join itself (`Join Filter: (card.channel_id = session.channel_id)`) resolves to a `Nested Loop` over the two one-row scans rather than a hash or merge join, which is the correct choice for the row counts involved and says nothing either way about plan shape at scale.

## Raw EXPLAIN output — literal function-call query

```
Function Scan on list_overlay_qr_smart_card  (cost=0.25..10.25 rows=1000 width=64) (actual time=1.882..1.883 rows=1 loops=1)
  Buffers: shared hit=378
Planning Time: 0.049 ms
Execution Time: 1.916 ms
```

## Raw EXPLAIN output — supplementary: function body unwrapped, parameters substituted with the same seeded literal values

This is the real plan for the SQL text covered by `query_hash` above (the function body, not the wrapper call).

```
Nested Loop  (cost=0.00..2.04 rows=1 width=67) (actual time=0.007..0.007 rows=1 loops=1)
  Join Filter: (card.channel_id = session.channel_id)
  Buffers: shared hit=2
  ->  Seq Scan on overlay_sessions session  (cost=0.00..1.02 rows=1 width=16) (actual time=0.004..0.005 rows=1 loops=1)
        Filter: ((revoked_at IS NULL) AND (id = '00000000-0000-4000-8000-000000009997'::uuid) AND (token_fingerprint = 'dfa3eabd969d400e4c16a504b0fb2cd645926191994016efb39ed0befe3a1fb3'::text) AND (expires_at > CURRENT_TIMESTAMP))
        Buffers: shared hit=1
  ->  Seq Scan on qr_smart_cards card  (cost=0.00..1.01 rows=1 width=83) (actual time=0.001..0.001 rows=1 loops=1)
        Filter: is_enabled
        Buffers: shared hit=1
Planning:
  Buffers: shared hit=216
Planning Time: 0.549 ms
Execution Time: 0.020 ms
```

## Returned row, reproduced

```
                 destination                  |          label          
------------------------------------------------+--------------------------
 https://bharatstudio.in/creator/synthetic-a     | Follow on BharatStudio
```

## Indexes present on `qr_smart_cards` and `overlay_sessions` in the captured database

Recorded because the claim "the primary key exists, the planner merely declined it at this size" is otherwise unverifiable from the plan alone.

```
qr_smart_cards_pkey       -- primary key, btree (channel_id)
overlay_sessions_pkey     -- primary key, btree (id)
```
