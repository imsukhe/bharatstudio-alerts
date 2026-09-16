-- PRF-02 slice 5, module #12 (Moderator Status Card, HELD HALF ONLY):
-- app_private.list_overlay_moderator_status (migration 0136).
--
-- This file owns id block ...5500-...55ff (recorded in
-- fixtures/00_base_world.sql's ID ALLOCATION REGISTRY). It seeds its OWN
-- channels rather than reusing base_world's ...0011/...0012, because the
-- thing under test is a COUNT: reusing a shared channel would let any
-- other file's queues or deliveries change the expected number, and a
-- count assertion that can be moved by an unrelated file is not an
-- assertion. Every row this file counts is a row this file inserted.
--
-- THE CASE THAT MATTERS MOST IS S5.4, THE RETURNED COLUMN SET. §6's
-- "never private content" is required to be a property of the query, not
-- of the renderer, so it is asserted here twice over: from the catalogue
-- (pg_get_function_result) and from a table materialised out of a real
-- call to the function and read back through information_schema.columns.
-- Either assertion fails the moment a second column is added, whatever
-- it is named -- which is exactly the negative test recorded in
-- bharatstudio-requirements/reviews/2026-09-16-prf-02-slice-5-implementation.md.
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------
-- Fixture. Two channels: A (the channel under test) and B (the
-- cross-channel probe). A has TWO queues, because 0026's
-- alert_queue_last_open_guard refuses to close a channel's final open
-- queue and case S5.6 needs a closed queue to count from.
-- ---------------------------------------------------------------------

insert into channels (id, owner_user_id, handle, display_name, accepting_tips, public_config_version, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000005511', '00000000-0000-4000-8000-000000000001', 'modstatus_a', 'Moderator Status A', true, 1, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000005512', '00000000-0000-4000-8000-000000000002', 'modstatus_b', 'Moderator Status B', true, 1, current_timestamp, current_timestamp)
on conflict (id) do nothing;

insert into channel_configs (channel_id, version, values, effective_at, created_at)
values
  ('00000000-0000-4000-8000-000000005511', 1, '{}'::jsonb, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000005512', 1, '{}'::jsonb, current_timestamp, current_timestamp)
on conflict (channel_id, version) do nothing;

insert into channel_memberships (channel_id, user_id, role, created_at)
values
  ('00000000-0000-4000-8000-000000005511', '00000000-0000-4000-8000-000000000001', 'owner', current_timestamp),
  ('00000000-0000-4000-8000-000000005512', '00000000-0000-4000-8000-000000000002', 'owner', current_timestamp)
on conflict (channel_id, user_id) do nothing;

insert into alert_queues (id, channel_id, name, is_paused, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000005521', '00000000-0000-4000-8000-000000005511', 'A primary', false, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000005522', '00000000-0000-4000-8000-000000005511', 'A secondary', false, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000005523', '00000000-0000-4000-8000-000000005512', 'B primary', false, current_timestamp, current_timestamp);

-- Four overlay sessions on purpose: a good one for A, a good one for B,
-- an already-expired one for A, and a revoked one for A. Each of the last
-- three is its own negative case in S5.3.
insert into overlay_sessions (id, channel_id, token_fingerprint, expires_at, created_at)
values
  ('00000000-0000-4000-8000-000000005531', '00000000-0000-4000-8000-000000005511', 'prf02s5-a-fingerprint', current_timestamp + interval '1 hour', current_timestamp),
  ('00000000-0000-4000-8000-000000005532', '00000000-0000-4000-8000-000000005512', 'prf02s5-b-fingerprint', current_timestamp + interval '1 hour', current_timestamp),
  ('00000000-0000-4000-8000-000000005533', '00000000-0000-4000-8000-000000005511', 'prf02s5-expired-fingerprint', current_timestamp - interval '1 minute', current_timestamp - interval '2 hours');

insert into overlay_sessions (id, channel_id, token_fingerprint, expires_at, created_at, revoked_at)
values
  ('00000000-0000-4000-8000-000000005534', '00000000-0000-4000-8000-000000005511', 'prf02s5-revoked-fingerprint', current_timestamp + interval '1 hour', current_timestamp, current_timestamp);

-- =====================================================================
-- S5.2 -- THE ZERO CASE IS A REAL ROW READING ZERO, NOT ZERO ROWS.
-- Asserted BEFORE anything is held, so it is the genuine empty state and
-- not a filtered-away result. The Canvas module depends on exactly this
-- distinction: one row of 0 means "nothing held" (hide the card), zero
-- rows means "not authorised" (a null snapshot). If these two collapsed
-- into the same answer the renderer could not tell them apart.
-- =====================================================================
do $$
declare row_count integer; held bigint;
begin
  select count(*) into row_count from app_private.list_overlay_moderator_status('00000000-0000-4000-8000-000000005531'::uuid, 'prf02s5-a-fingerprint');
  if row_count <> 1 then raise exception 'a VALID overlay session with nothing held must return exactly one row, got %', row_count; end if;
  select held_count into held from app_private.list_overlay_moderator_status('00000000-0000-4000-8000-000000005531'::uuid, 'prf02s5-a-fingerprint');
  if held <> 0 then raise exception 'with nothing held the count must be 0, got %', held; end if;
end
$$;

-- ---------------------------------------------------------------------
-- Held deliveries for channel A on its primary queue. Each delivery gets
-- its own alert_event and its own event_outbox row: 0021's
-- event_outbox_delivery_duplicate_consent guard refuses a second
-- delivery for the same outbox_id without explicit binding consent, and
-- reusing one outbox here would be testing that guard by accident.
-- ---------------------------------------------------------------------
insert into alert_events (id, channel_id, source_type, source_id, trace_id, config_snapshot_version, payload, created_at)
values
  ('00000000-0000-4000-8000-000000005541', '00000000-0000-4000-8000-000000005511', 'manual', 'prf02s5-held-1', 'trace-prf02s5-held-1', 1, '{"message":"synthetic"}'::jsonb, current_timestamp),
  ('00000000-0000-4000-8000-000000005542', '00000000-0000-4000-8000-000000005511', 'manual', 'prf02s5-held-2', 'trace-prf02s5-held-2', 1, '{"message":"synthetic"}'::jsonb, current_timestamp),
  ('00000000-0000-4000-8000-000000005543', '00000000-0000-4000-8000-000000005511', 'manual', 'prf02s5-held-3', 'trace-prf02s5-held-3', 1, '{"message":"synthetic"}'::jsonb, current_timestamp);

insert into event_outbox (id, event_id, status, available_at, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000005551', '00000000-0000-4000-8000-000000005541', 'pending', current_timestamp, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000005552', '00000000-0000-4000-8000-000000005542', 'pending', current_timestamp, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000005553', '00000000-0000-4000-8000-000000005543', 'pending', current_timestamp, current_timestamp, current_timestamp);

insert into event_outbox_deliveries (id, event_id, outbox_id, queue_id, binding_id, source_id, config_snapshot_version, delivery_sequence, status, hold_reason, attempt_count, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000005561', '00000000-0000-4000-8000-000000005541', '00000000-0000-4000-8000-000000005551', '00000000-0000-4000-8000-000000005521', '00000000-0000-4000-8000-000000005591', 'prf02s5-held-1', 1, 1, 'held', 'moderation', 0, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000005562', '00000000-0000-4000-8000-000000005542', '00000000-0000-4000-8000-000000005552', '00000000-0000-4000-8000-000000005521', '00000000-0000-4000-8000-000000005591', 'prf02s5-held-2', 1, 1, 'held', 'moderation', 0, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000005563', '00000000-0000-4000-8000-000000005543', '00000000-0000-4000-8000-000000005553', '00000000-0000-4000-8000-000000005521', '00000000-0000-4000-8000-000000005591', 'prf02s5-held-3', 1, 1, 'held', 'moderation', 0, current_timestamp, current_timestamp);

-- =====================================================================
-- S5.1 (first half) -- held deliveries are counted.
-- =====================================================================
do $$
declare held bigint;
begin
  select held_count into held from app_private.list_overlay_moderator_status('00000000-0000-4000-8000-000000005531'::uuid, 'prf02s5-a-fingerprint');
  if held <> 3 then raise exception 'expected 3 held deliveries for channel A, got %', held; end if;
end
$$;

-- ---------------------------------------------------------------------
-- Every OTHER delivery status, one row each, on the same channel and the
-- same queue. If the count were "deliveries" rather than "held
-- deliveries" this would take it from 3 to 11.
-- ---------------------------------------------------------------------
do $$
declare
  other_status text;
  n integer := 0;
  event_id uuid;
  outbox_id uuid;
begin
  foreach other_status in array array['pending', 'ready', 'displayed', 'acknowledged', 'failed_retriable', 'quarantined', 'suppressed', 'refunded_after_display']
  loop
    n := n + 1;
    event_id := ('00000000-0000-4000-8000-0000000055a' || n)::uuid;
    outbox_id := ('00000000-0000-4000-8000-0000000055b' || n)::uuid;
    insert into alert_events (id, channel_id, source_type, source_id, trace_id, config_snapshot_version, payload, created_at)
    values (event_id, '00000000-0000-4000-8000-000000005511', 'manual', 'prf02s5-other-' || n, 'trace-prf02s5-other-' || n, 1, '{"message":"synthetic"}'::jsonb, current_timestamp);
    insert into event_outbox (id, event_id, status, available_at, created_at, updated_at)
    values (outbox_id, event_id, 'pending', current_timestamp, current_timestamp, current_timestamp);
    insert into event_outbox_deliveries (id, event_id, outbox_id, queue_id, binding_id, source_id, config_snapshot_version, delivery_sequence, status, attempt_count, created_at, updated_at)
    values (('00000000-0000-4000-8000-0000000055c' || n)::uuid, event_id, outbox_id, '00000000-0000-4000-8000-000000005521', '00000000-0000-4000-8000-000000005591', 'prf02s5-other-' || n, 1, 1, other_status, 0, current_timestamp, current_timestamp);
  end loop;
end
$$;

-- =====================================================================
-- S5.1 (second half) -- only 'held' is counted. Eight deliveries in eight
-- other statuses were just added to the very same queue; the count must
-- not have moved.
-- =====================================================================
do $$
declare held bigint; total bigint;
begin
  select held_count into held from app_private.list_overlay_moderator_status('00000000-0000-4000-8000-000000005531'::uuid, 'prf02s5-a-fingerprint');
  select count(*) into total from public.event_outbox_deliveries d join public.alert_queues q on q.id = d.queue_id where q.channel_id = '00000000-0000-4000-8000-000000005511';
  if total <> 11 then raise exception 'fixture error: expected 11 deliveries on channel A in total, got %', total; end if;
  if held <> 3 then raise exception 'only held deliveries may be counted: expected 3 of 11, got %', held; end if;
end
$$;

-- ---------------------------------------------------------------------
-- One held delivery on channel A's SECOND queue, inserted while that
-- queue is still open (0026's event_outbox_delivery_open_queue_guard
-- refuses an insert onto a closed queue), so S5.6 can close it
-- afterwards and show the count is unchanged.
-- ---------------------------------------------------------------------
insert into alert_events (id, channel_id, source_type, source_id, trace_id, config_snapshot_version, payload, created_at)
values ('00000000-0000-4000-8000-000000005544', '00000000-0000-4000-8000-000000005511', 'manual', 'prf02s5-held-4', 'trace-prf02s5-held-4', 1, '{"message":"synthetic"}'::jsonb, current_timestamp);

insert into event_outbox (id, event_id, status, available_at, created_at, updated_at)
values ('00000000-0000-4000-8000-000000005554', '00000000-0000-4000-8000-000000005544', 'pending', current_timestamp, current_timestamp, current_timestamp);

insert into event_outbox_deliveries (id, event_id, outbox_id, queue_id, binding_id, source_id, config_snapshot_version, delivery_sequence, status, hold_reason, attempt_count, created_at, updated_at)
values ('00000000-0000-4000-8000-000000005564', '00000000-0000-4000-8000-000000005544', '00000000-0000-4000-8000-000000005554', '00000000-0000-4000-8000-000000005522', '00000000-0000-4000-8000-000000005592', 'prf02s5-held-4', 1, 1, 'held', 'moderation', 0, current_timestamp, current_timestamp);

do $$
declare held bigint;
begin
  select held_count into held from app_private.list_overlay_moderator_status('00000000-0000-4000-8000-000000005531'::uuid, 'prf02s5-a-fingerprint');
  if held <> 4 then raise exception 'held deliveries across ALL of the channel''s queues must be counted: expected 4, got %', held; end if;
end
$$;

-- =====================================================================
-- S5.6 -- QUEUE LIFECYCLE DOES NOT FILTER THE COUNT, and the owner's
-- first decision is proven here operationally rather than by comment:
-- pausing a queue must change the count by exactly zero. If the function
-- had quietly reused the paused flag as a stand-in for "safe mode", or
-- filtered on it in either direction, this assertion would move.
-- =====================================================================
update public.alert_queues set is_paused = true, updated_at = current_timestamp
 where id = '00000000-0000-4000-8000-000000005521';

do $$
declare held bigint;
begin
  select held_count into held from app_private.list_overlay_moderator_status('00000000-0000-4000-8000-000000005531'::uuid, 'prf02s5-a-fingerprint');
  if held <> 4 then raise exception 'pausing a queue must not change the held count (pausing is a queue lifecycle state; held is a delivery state): expected 4, got %', held; end if;
end
$$;

-- Closing the SECOND queue is allowed because the primary is still open
-- (0026's alert_queue_last_open_guard). Its held delivery stays held.
update public.alert_queues set closed_at = current_timestamp, updated_at = current_timestamp
 where id = '00000000-0000-4000-8000-000000005522';

do $$
declare held bigint;
begin
  select held_count into held from app_private.list_overlay_moderator_status('00000000-0000-4000-8000-000000005531'::uuid, 'prf02s5-a-fingerprint');
  if held <> 4 then raise exception 'closing a queue must not change the held count: expected 4, got %', held; end if;
end
$$;

-- ---------------------------------------------------------------------
-- Channel B's own held deliveries, for the cross-channel probe.
-- ---------------------------------------------------------------------
insert into alert_events (id, channel_id, source_type, source_id, trace_id, config_snapshot_version, payload, created_at)
values
  ('00000000-0000-4000-8000-000000005545', '00000000-0000-4000-8000-000000005512', 'manual', 'prf02s5-b-held-1', 'trace-prf02s5-b-held-1', 1, '{"message":"synthetic"}'::jsonb, current_timestamp),
  ('00000000-0000-4000-8000-000000005546', '00000000-0000-4000-8000-000000005512', 'manual', 'prf02s5-b-held-2', 'trace-prf02s5-b-held-2', 1, '{"message":"synthetic"}'::jsonb, current_timestamp);

insert into event_outbox (id, event_id, status, available_at, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000005555', '00000000-0000-4000-8000-000000005545', 'pending', current_timestamp, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000005556', '00000000-0000-4000-8000-000000005546', 'pending', current_timestamp, current_timestamp, current_timestamp);

insert into event_outbox_deliveries (id, event_id, outbox_id, queue_id, binding_id, source_id, config_snapshot_version, delivery_sequence, status, hold_reason, attempt_count, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000005565', '00000000-0000-4000-8000-000000005545', '00000000-0000-4000-8000-000000005555', '00000000-0000-4000-8000-000000005523', '00000000-0000-4000-8000-000000005593', 'prf02s5-b-held-1', 1, 1, 'held', 'moderation', 0, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000005566', '00000000-0000-4000-8000-000000005546', '00000000-0000-4000-8000-000000005556', '00000000-0000-4000-8000-000000005523', '00000000-0000-4000-8000-000000005593', 'prf02s5-b-held-2', 1, 1, 'held', 'moderation', 0, current_timestamp, current_timestamp);

-- =====================================================================
-- S5.3 -- EVERY AUTH NEGATIVE RETURNS ZERO ROWS, NEVER AN ERROR AND
-- NEVER ANOTHER CHANNEL'S COUNT.
-- =====================================================================
do $$
declare row_count integer; held bigint;
begin
  -- Cross-channel: A's session must not see B's two, and B's session
  -- must see exactly its own two and none of A's four.
  select held_count into held from app_private.list_overlay_moderator_status('00000000-0000-4000-8000-000000005531'::uuid, 'prf02s5-a-fingerprint');
  if held <> 4 then raise exception 'channel A must still read 4 after channel B held two of its own, got %', held; end if;
  select held_count into held from app_private.list_overlay_moderator_status('00000000-0000-4000-8000-000000005532'::uuid, 'prf02s5-b-fingerprint');
  if held <> 2 then raise exception 'channel B must read exactly its own 2, got %', held; end if;

  -- A correct overlay id with the WRONG fingerprint.
  select count(*) into row_count from app_private.list_overlay_moderator_status('00000000-0000-4000-8000-000000005531'::uuid, 'prf02s5-wrong-fingerprint');
  if row_count <> 0 then raise exception 'a wrong token fingerprint must return zero rows, got %', row_count; end if;

  -- A's fingerprint presented against B's overlay id, and vice versa.
  select count(*) into row_count from app_private.list_overlay_moderator_status('00000000-0000-4000-8000-000000005532'::uuid, 'prf02s5-a-fingerprint');
  if row_count <> 0 then raise exception 'a fingerprint from another channel''s session must return zero rows, got %', row_count; end if;

  -- An EXPIRED session.
  select count(*) into row_count from app_private.list_overlay_moderator_status('00000000-0000-4000-8000-000000005533'::uuid, 'prf02s5-expired-fingerprint');
  if row_count <> 0 then raise exception 'an expired overlay session must return zero rows, got %', row_count; end if;

  -- A REVOKED session.
  select count(*) into row_count from app_private.list_overlay_moderator_status('00000000-0000-4000-8000-000000005534'::uuid, 'prf02s5-revoked-fingerprint');
  if row_count <> 0 then raise exception 'a revoked overlay session must return zero rows, got %', row_count; end if;

  -- An overlay id that does not exist at all.
  select count(*) into row_count from app_private.list_overlay_moderator_status('00000000-0000-4000-8000-0000000055ff'::uuid, 'prf02s5-a-fingerprint');
  if row_count <> 0 then raise exception 'an unknown overlay id must return zero rows, got %', row_count; end if;
end
$$;

-- =====================================================================
-- S5.4 -- THE RETURNED COLUMN SET IS EXACTLY {held_count, safe_mode},
-- AND NOTHING ELSE, EVER.
--
-- EXTENDED, NOT WEAKENED, 2026-09-16. Slice 5 asserted exactly
-- {held_count}. Safe mode (migration 0138) completes §6 module #12's
-- other half under the owner's decision 3 of that date, so the declared
-- type is now two columns. This case was UPDATED to the new declared
-- type rather than deleted or loosened: it still fails by name the
-- moment a THIRD column appears, whatever it is called.
--
-- This is §6's "never private content" expressed as an executable
-- assertion about the QUERY rather than a rule a reviewer has to
-- enforce on the renderer. A boolean is not a supporter, a message or
-- an amount; anything that is, still cannot get past here. Two
-- independent checks, because one is a single point of failure:
--
--   (a) the catalogue's declared result type, which fails if the
--       `returns table (...)` signature ever grows a column; and
--   (b) the ACTUAL shape of a real call, materialised into a table and
--       read back through information_schema.columns, which fails if
--       the select list ever emits something the signature did not
--       declare.
--
-- Adding any further column at all -- a supporter name, a message, an
-- amount, a delivery id, a viewer identifier, or even an
-- innocuous-looking queue id -- turns this file red by name.
-- =====================================================================
do $$
declare declared_result text;
begin
  select pg_catalog.pg_get_function_result(p.oid)
    into declared_result
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private'
     and p.proname = 'list_overlay_moderator_status';

  if declared_result is null then raise exception 'app_private.list_overlay_moderator_status does not exist'; end if;
  if declared_result <> 'TABLE(held_count bigint, safe_mode boolean)' then
    raise exception 'the overlay moderator-status read must return the held COUNT and the safe-mode FLAG and nothing else (§6: never private content, enforced as a property of the query). Declared result is "%", expected exactly "TABLE(held_count bigint, safe_mode boolean)"', declared_result;
  end if;
end
$$;

create temporary table prf02s5_returned_shape as
  select * from app_private.list_overlay_moderator_status('00000000-0000-4000-8000-000000005531'::uuid, 'prf02s5-a-fingerprint');

do $$
declare actual_columns text;
begin
  select string_agg(column_name || ' ' || data_type, ', ' order by ordinal_position)
    into actual_columns
    from information_schema.columns
   where table_name = 'prf02s5_returned_shape';

  if actual_columns <> 'held_count bigint, safe_mode boolean' then
    raise exception 'the columns actually returned by a live call must be exactly "held_count bigint, safe_mode boolean", got "%" -- any additional column is private content leaving the database on the overlay path', actual_columns;
  end if;
end
$$;

-- =====================================================================
-- S5.5 -- THE QUEUE-PAUSED FLAG STILL HAS NO SURFACE HERE, AND THE
-- SAFE-MODE FLAG THAT DOES IS THE CREATOR'S OWN COLUMN -- BOTH PROVEN
-- AGAINST THE SHIPPED FUNCTION DEFINITION.
--
-- Owner decision, 2026-09-16 (§6's module table): "safe mode" is NOT
-- alert_queues.is_paused. Safe mode arriving as a real, creator-owned
-- per-channel switch (public.channels.safe_mode_enabled, migration
-- 0138) does NOT make the queue-paused flag publishable -- it remains a
-- queue lifecycle state and must never reach an overlay under any
-- label.
--
-- So this case now asserts BOTH directions:
--   * the definition still never references is_paused, and still never
--     filters on queue closure; and
--   * it positively DOES read safe_mode_enabled, so a build that
--     silently dropped the flag while leaving the column in the
--     signature fails here rather than shipping a card that always
--     reads "off".
-- Asserted against pg_get_functiondef, which is the definition the
-- database actually holds, not a comment anyone could let drift.
-- =====================================================================
do $$
declare definition text;
begin
  select pg_catalog.pg_get_functiondef(p.oid)
    into definition
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private'
     and p.proname = 'list_overlay_moderator_status';

  if definition ilike '%is_paused%' then
    raise exception 'the overlay moderator-status read must never reference the queue-paused flag: the owner decided on 2026-09-16 that safe mode is NOT that flag, and safe mode having since been built does not make it publishable';
  end if;
  if definition not ilike '%safe_mode_enabled%' then
    raise exception 'the overlay moderator-status read must read public.channels.safe_mode_enabled -- the creator''s own switch is the whole of §6 module #12''s second half, and a definition that does not read it would report every channel as off';
  end if;
  if definition ilike '%closed_at%' then
    raise exception 'the overlay moderator-status read must not filter on queue closure: closing is a queue lifecycle state, held is a delivery state';
  end if;
end
$$;

-- =====================================================================
-- S5.11 -- SAFE MODE IS VISIBLE THROUGH THIS READ, AND IS STILL
-- CHANNEL-SCOPED BY THE SESSION.
--
-- Channel A's session must see A's flag and never B's. Asserted here
-- rather than only in prf02_safe_mode.sql because the cross-channel
-- gate is THIS file's subject and a new column is a new thing that
-- could leak across it.
-- =====================================================================
update public.channels set safe_mode_enabled = true, updated_at = current_timestamp
 where id = '00000000-0000-4000-8000-000000005511';

do $$
declare a_safe boolean; b_safe boolean; a_held bigint;
begin
  select safe_mode, held_count into a_safe, a_held
    from app_private.list_overlay_moderator_status('00000000-0000-4000-8000-000000005531'::uuid, 'prf02s5-a-fingerprint');
  select safe_mode into b_safe
    from app_private.list_overlay_moderator_status('00000000-0000-4000-8000-000000005532'::uuid, 'prf02s5-b-fingerprint');

  if a_safe is not true then raise exception 'channel A''s session must read its own safe mode as on, got %', a_safe; end if;
  if b_safe is not false then raise exception 'channel B''s session must read its OWN safe mode (off), never A''s, got %', b_safe; end if;
  if a_held <> 4 then raise exception 'turning safe mode on must not change the held count of deliveries that already exist: expected 4, got %', a_held; end if;
end
$$;

-- And back off again, so the rest of this file sees the state it seeded.
update public.channels set safe_mode_enabled = false, updated_at = current_timestamp
 where id = '00000000-0000-4000-8000-000000005511';

do $$
declare a_safe boolean; a_held bigint;
begin
  select safe_mode, held_count into a_safe, a_held
    from app_private.list_overlay_moderator_status('00000000-0000-4000-8000-000000005531'::uuid, 'prf02s5-a-fingerprint');
  if a_safe is not false then raise exception 'turning safe mode off must be visible on the same read, got %', a_safe; end if;
  if a_held <> 4 then raise exception 'turning safe mode OFF must not release, delete or hide anything already held: expected 4, got %', a_held; end if;
end
$$;

select 'prf02_slice5_moderator_status.sql: all assertions passed' as result;
